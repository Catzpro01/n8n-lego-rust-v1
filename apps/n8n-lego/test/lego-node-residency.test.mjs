/**
 * P6.7 — Node residency: manifest/implementation split, HOT/WARM/COLD.
 * Contract `node.residency@0.1.0`.
 *
 * Matrix: the split (manifest residency is not implementation residency), the
 * COLD → WARM → HOT order (a load from cold is refused rather than quietly
 * warming as a side effect), the bounded hot tier with a REPORTED least-recently-used
 * demotion, eviction that respects leases (refused with the holders named),
 * the WARM → COLD drop with its own ordering rule, the census and formats, the
 * monotonic tick instead of a clock, and the scope walls.
 *
 * Epochs are real: they come from P6.2, built from P6.1 declarations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  DEFAULT_HOT_BUDGET,
  MANIFEST_RESIDENT_TIERS,
  RESIDENCY_CONTRACT,
  RESIDENCY_CONTRACT_VERSION,
  RESIDENCY_INPUT_SCHEMA_VERSION,
  RESIDENCY_OPERATIONS,
  RESIDENCY_PERMISSIONS,
  RESIDENCY_REASONS,
  RESIDENCY_RULES,
  RESIDENCY_SCHEMA_VERSION,
  RESIDENCY_TIERS,
  ResidencyError,
  createResidencyTable,
  describeResidency,
  dropNode,
  evictNode,
  formatResidency,
  hotHeadroom,
  hotNodes,
  isResidencyTable,
  loadNode,
  manifestResidentNodes,
  residencyCandidates,
  residencyOf,
  warmNode,
} from '../src/lego/node-residency.mjs';

const HTTP = 'n8n-nodes-base.httpRequest';
const A = `${HTTP}@4`;
const B = `${HTTP}@4.1`;
const C = `${HTTP}@4.4`;
const D = `${HTTP}@5`;

const declaration = (typeVersion, digestChar) => ({
  type: HTTP,
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

const EPOCH = (() => {
  const epoch = compileRegistryEpoch({ declarations: [declaration(4, 'a'), declaration(4.1, 'b'), declaration(4.4, 'c'), declaration(5, 'd')], source: 'catalog:n8n-nodes-base@2.9.1' });
  assert.equal(epoch.ok, true);
  return epoch;
})();

const table = (maxHot = 8) => createResidencyTable({ epoch: EPOCH, maxHot });
const warm = (current, ...identities) => identities.reduce((acc, identity) => warmNode(acc, identity).table, current);
const load = (current, identity) => {
  const result = loadNode(current, identity);
  assert.equal(result.ok, true, `expected ${identity} to load: ${result.reason}`);
  return result.table;
};

/* ---------------------------------------------------------------- contract */

test('the contract identifies itself, is versioned and fixes the tiers', () => {
  assert.equal(RESIDENCY_CONTRACT, 'node.residency@0.1.0');
  assert.equal(RESIDENCY_CONTRACT_VERSION, '0.1.0');
  assert.equal(RESIDENCY_SCHEMA_VERSION, 1);
  assert.deepEqual([...RESIDENCY_OPERATIONS], ['warm', 'load', 'evict', 'describe']);
  assert.deepEqual([...RESIDENCY_TIERS], ['cold', 'warm', 'hot']);
  assert.deepEqual([...MANIFEST_RESIDENT_TIERS], ['warm', 'hot']);
  assert.ok(DEFAULT_HOT_BUDGET >= 1 && DEFAULT_HOT_BUDGET < 100);
  assert.ok(RESIDENCY_PERMISSIONS.every((word) => typeof word === 'string'));
  assert.equal(RESIDENCY_INPUT_SCHEMA_VERSION, 1);
});

test('the refusal vocabulary is closed, prefixed and free of duplicates', () => {
  assert.ok(RESIDENCY_REASONS.length >= 5);
  assert.equal(new Set(RESIDENCY_REASONS).size, RESIDENCY_REASONS.length);
  assert.ok(RESIDENCY_REASONS.every((reason) => reason.startsWith('residency.')));
  assert.match(RESIDENCY_RULES.split, /metadata is read before code is loaded/);
  assert.match(RESIDENCY_RULES.bounded, /out-of-memory/);
  assert.match(RESIDENCY_RULES.leases, /executions named/);
});

/* ----------------------------------------------------------------- table */

test('every node in an epoch starts COLD: knowing about a node is not having it', () => {
  const created = table();
  assert.equal(created.identityCount, 4);
  assert.equal(created.tick, 0);
  assert.equal(residencyOf(created, A), 'cold');
  assert.deepEqual([...hotNodes(created)], []);
  assert.deepEqual([...manifestResidentNodes(created)], []);
  assert.ok(isResidencyTable(created));
  assert.ok(Object.isFrozen(created) && Object.isFrozen(created.entries) && Object.isFrozen(created.entries[A]));
  assert.equal(formatResidency(created), 'residency: 0 hot / 0 warm / 4 cold of 4 (budget 8)');
});

test('a table requires a compiled epoch and a bounded budget', () => {
  assert.throws(() => createResidencyTable({ epoch: { ok: true, epochNumber: 1 } }), ResidencyError);
  assert.throws(() => createResidencyTable({}), ResidencyError);
  for (const maxHot of [0, -1, 1.5, 'many', null]) {
    assert.throws(() => createResidencyTable({ epoch: EPOCH, maxHot }), (error) => error.meta.code === 'residency.budget');
  }
  assert.equal(createResidencyTable({ epoch: EPOCH, maxHot: 1 }).maxHot, 1);
  assert.equal(createResidencyTable({ epoch: EPOCH }).maxHot, DEFAULT_HOT_BUDGET);
});

test('an identity the epoch does not have cannot be made resident', () => {
  assert.throws(() => warmNode(table(), 'n8n-nodes-base.ghost@1'), (error) => {
    assert.equal(error.meta.code, 'residency.identity');
    assert.match(error.message, /registry does not have/);
    return true;
  });
  assert.throws(() => loadNode(table(), 'n8n-nodes-base.ghost@1'), ResidencyError);
  assert.throws(() => evictNode(table(), 'n8n-nodes-base.ghost@1', { inUseBy: [] }), ResidencyError);
  assert.equal(residencyOf(table(), 'n8n-nodes-base.ghost@1'), null);
});

/* -------------------------------------------------------------- the split */

test('COLD → WARM brings the MANIFEST only: the implementation is still not here', () => {
  const warmed = warmNode(table(), A);
  assert.equal(warmed.ok, true);
  assert.equal(warmed.tier, 'warm');
  assert.equal(warmed.reason, 'warmed');
  assert.equal(residencyOf(warmed.table, A), 'warm');
  assert.deepEqual([...manifestResidentNodes(warmed.table)], [A]);
  assert.deepEqual([...hotNodes(warmed.table)], [], 'warming a manifest must not load an implementation');
  const census = describeResidency(warmed.table);
  assert.equal(census.manifestResident, 1);
  assert.equal(census.implementationResident, 0);
});

test('WARM → HOT brings the implementation, and only then', () => {
  let current = warm(table(), A);
  current = load(current, A);
  assert.equal(residencyOf(current, A), 'hot');
  assert.deepEqual([...hotNodes(current)], [A]);
  const census = describeResidency(current);
  assert.equal(census.tiers.hot, 1);
  assert.equal(census.tiers.warm, 0);
  assert.equal(census.implementationResident, 1);
  assert.equal(census.manifestResident, 1);
});

test('a load straight from COLD is refused, not quietly warmed as a side effect', () => {
  assert.throws(() => loadNode(table(), A), (error) => {
    assert.equal(error.meta.code, 'residency.order');
    assert.match(error.message, /metadata is read before code is loaded, which is what leaves room for a check to happen/);
    return true;
  });
  // And nothing changed: the refusal is not a partial warm.
  assert.equal(residencyOf(table(), A), 'cold');
});

test('warming or loading twice is a no-op that only refreshes recency', () => {
  const first = warmNode(table(), A);
  const again = warmNode(first.table, A);
  assert.equal(again.reason, 'already-resident');
  assert.equal(again.tier, 'warm');
  assert.equal(again.table.tick, first.table.tick + 1, 'an access is an access');
  const hotOnce = load(first.table, A);
  const hotTwice = loadNode(hotOnce, A);
  assert.equal(hotTwice.reason, 'already-hot');
  assert.deepEqual([...hotTwice.demoted], []);
  assert.equal(hotTwice.table.entries[A].loads, 1, 're-loading is not a second load');
  assert.equal(hotTwice.table.loads, 1, 'the table counts actual loads, not requests');
});

/* ------------------------------------------------------------- hot budget */

test('the hot tier is bounded, and exceeding it demotes the LEAST-RECENTLY-USED node', () => {
  let current = warm(table(2), A, B, C);
  current = load(current, A);
  current = load(current, B);
  const third = loadNode(current, C);
  assert.equal(third.ok, true);
  assert.equal(third.reason, 'loaded');
  assert.deepEqual([...third.demoted], [A], 'A was used least recently');
  assert.equal(residencyOf(third.table, A), 'warm', 'the demoted node keeps its manifest');
  assert.equal(residencyOf(third.table, B), 'hot');
  assert.equal(residencyOf(third.table, C), 'hot');
  assert.equal(describeResidency(third.table).tiers.hot, 2);
  assert.equal(describeResidency(third.table).demotions, 1);
  assert.equal(hotHeadroom(third.table), 0);
  assert.equal(describeResidency(third.table).atBudget, true);
});

test('recency is a monotonic tick: using a node again protects it from demotion', () => {
  let current = warm(table(2), A, B, C);
  current = load(current, A);
  current = load(current, B);
  current = warm(current, A); // A is used again, so B is now the least recent
  const third = loadNode(current, C);
  assert.deepEqual([...third.demoted], [B], 'recency follows USE, not load order');
  assert.equal(residencyOf(third.table, A), 'hot');
});

test('a budget of one keeps exactly one implementation resident and reports every demotion', () => {
  let current = warm(table(1), A, B, C);
  current = load(current, A);
  const second = loadNode(current, B);
  assert.deepEqual([...second.demoted], [A]);
  const third = loadNode(second.table, C);
  assert.deepEqual([...third.demoted], [B]);
  assert.equal(describeResidency(third.table).tiers.hot, 1);
  assert.equal(describeResidency(third.table).demotions, 2);
  assert.equal(residencyOf(third.table, C), 'hot');
});

/* ----------------------------------------------------------- leases/evict */

test('an implementation still held by an execution is never unloaded, and the holders are named', () => {
  let current = load(warm(table(), A), A);
  const refused = evictNode(current, A, { inUseBy: ['exec-1', 'exec-2'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'residency.in-use');
  assert.deepEqual([...refused.error.holders], ['exec-1', 'exec-2']);
  assert.match(refused.error.message, /an implementation in use is never unloaded/);
  assert.equal(residencyOf(refused.table, A), 'hot', 'the refusal must not half-evict');
  assert.equal(describeResidency(refused.table).refusals, 1);
  assert.equal(evictNode(current, A, { inUseBy: new Set() }).reason, 'evicted');
});

test('eviction without the in-use set is refused: evicting without asking loses a running implementation', () => {
  const current = load(warm(table(), A), A);
  assert.throws(() => evictNode(current, A), (error) => error.meta.code === 'residency.in-use');
  assert.throws(() => evictNode(current, A, {}), (error) => error.meta.code === 'residency.in-use');
  assert.throws(() => dropNode(current, A), (error) => error.meta.code === 'residency.in-use');
});

test('evicting keeps the manifest; dropping is a separate, ordered step', () => {
  let current = load(warm(table(), A), A);
  const evicted = evictNode(current, A, { inUseBy: [] });
  assert.equal(evicted.tier, 'warm');
  assert.equal(residencyOf(evicted.table, A), 'warm');
  assert.equal(residencyOf(evicted.table, A) === 'cold', false, 'evicting is not dropping');
  const dropped = dropNode(evicted.table, A, { inUseBy: [] });
  assert.equal(dropped.tier, 'cold');
  assert.equal(residencyOf(dropped.table, A), 'cold');
  assert.deepEqual([...manifestResidentNodes(dropped.table)], []);
});

test('a HOT node cannot be dropped straight to COLD: evict first', () => {
  const current = load(warm(table(), A), A);
  assert.throws(() => dropNode(current, A, { inUseBy: [] }), (error) => error.meta.code === 'residency.order');
});

test('evicting or dropping an already-demoted node is a no-op that says which', () => {
  const current = warm(table(), A);
  assert.equal(evictNode(current, A, { inUseBy: [] }).reason, 'already-warm');
  assert.equal(dropNode(current, A, { inUseBy: [] }).reason, 'dropped');
  assert.equal(dropNode(table(), A, { inUseBy: [] }).reason, 'already-cold');
  const dropped = dropNode(current, A, { inUseBy: [] }).table;
  assert.equal(evictNode(dropped, A, { inUseBy: [] }).reason, 'already-cold');
});

/* ----------------------------------------------------------------- census */

test('the census separates manifest residency from implementation residency', () => {
  let current = warm(table(4), A, B, C, D);
  current = load(current, A);
  current = load(current, B);
  const census = describeResidency(current);
  assert.deepEqual(census.tiers, { cold: 0, warm: 2, hot: 2 });
  assert.equal(census.identityCount, 4);
  assert.deepEqual([...census.hot].sort(), [A, B].sort());
  assert.deepEqual([...census.warm].sort(), [C, D].sort());
  assert.equal(census.manifestResident, 4, 'a hot node has its manifest resident too');
  assert.equal(census.implementationResident, 2);
  assert.equal(census.hotBudget, 4);
  assert.equal(census.epochDigest, EPOCH.epochDigest);
  assert.equal(census.epochSource, 'catalog:n8n-nodes-base@2.9.1');
  assert.ok(Object.isFrozen(census) && Object.isFrozen(census.tiers));
});

test('the census never lies about the three tiers adding up', () => {
  let current = warm(table(2), A, B, C, D);
  current = load(current, A);
  current = load(current, B);
  current = load(current, C);
  const census = describeResidency(current);
  assert.equal(census.tiers.cold + census.tiers.warm + census.tiers.hot, census.identityCount);
  assert.equal(census.tiers.hot + hotHeadroom(current), current.maxHot);
});

test('formatResidency states the tiers, the catalogue size and the budget', () => {
  let current = warm(table(2), A);
  assert.equal(formatResidency(current), 'residency: 0 hot / 1 warm / 3 cold of 4 (budget 2)');
  current = load(current, A);
  assert.equal(formatResidency(current), 'residency: 1 hot / 0 warm / 3 cold of 4 (budget 2)');
});

test('residencyCandidates proposes what to warm next, from cold only', () => {
  const current = warm(table(), A);
  assert.deepEqual([...residencyCandidates(current, [A, B, C, B, 'n8n-nodes-base.ghost@1'])], [B, C].sort());
  assert.deepEqual([...residencyCandidates(current, [])], []);
  assert.throws(() => residencyCandidates(current, 'all'), ResidencyError);
});

test('every read refuses a value this contract did not produce', () => {
  for (const fn of [hotNodes, manifestResidentNodes, describeResidency, formatResidency, residencyOf, hotHeadroom, residencyCandidates]) {
    assert.throws(() => fn({ ok: true }, []), ResidencyError, `${fn.name} must refuse a forged table`);
  }
  assert.equal(isResidencyTable({ ...table() }), false, 'a shallow copy is not a table');
  assert.equal(isResidencyTable(JSON.parse(JSON.stringify(table()))), false);
});

/* ------------------------------------------------------------ determinism */

test('the same operations produce the same census on any host — recency is a tick, not a clock', () => {
  const run = () => {
    let current = warm(table(2), A, B, C);
    current = load(current, A);
    current = load(current, B);
    current = load(current, C);
    current = evictNode(current, B, { inUseBy: [] }).table;
    return current;
  };
  const first = run();
  const second = run();
  assert.deepEqual(describeResidency(first), describeResidency(second));
  assert.equal(first.tick, second.tick);
  assert.equal(JSON.stringify(first.entries), JSON.stringify(second.entries));
});

test('the tick only ever moves forward, one per operation', () => {
  let current = table();
  const seen = [current.tick];
  for (const step of [warmNode(current, A).table, warmNode(warmNode(current, A).table, B).table]) {
    current = step;
    seen.push(current.tick);
  }
  current = load(current, A);
  seen.push(current.tick);
  current = evictNode(current, A, { inUseBy: [] }).table;
  seen.push(current.tick);
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'never decreasing');
  assert.equal(new Set(seen).size, seen.length, 'and never repeating');
});

/* ------------------------------------------------------------ scope walls */

test('P6.7 publishes exactly one contract row and leaves the rest of P6 alone', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.residency');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, RESIDENCY_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.deepEqual(rows[0].surface, ['src/lego/node-residency.mjs']);
  for (const [id, version] of [['node.registry', '0.1.0'], ['registry.compiler', '0.1.0'], ['package.transaction', '0.1.0'], ['registry.closure', '0.1.0'], ['node.resolution', '0.1.0'], ['runtime.lease', '0.1.0']]) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, version, `P6.7 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/node-residency.mjs'));
});

test('P6.7 is pure: no clock, no filesystem, no network, no execution and no pool', () => {
  const source = readFileSync(new URL('../src/lego/node-residency.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', "from 'node:crypto'"]) {
    assert.equal(code.includes(forbidden), false, `node residency must not reference ${forbidden}`);
  }
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'recency is a tick; a clock would make the table unreproducible');
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
  assert.match(source, /from '\.\/registry-compiler\.mjs'/);
  for (const other of ['runtime-lease.mjs', 'resolution-manifest.mjs', 'dependency-closure.mjs', 'execution-ir', 'resource-guard']) {
    assert.equal(code.includes(other), false, `P6.7 must not reach into ${other}: the lease set is passed in as data`);
  }
});

test('P6.7 scope walls: no capability, trust, health, quarantine, pool or attestation', () => {
  const names = Object.keys({
    RESIDENCY_CONTRACT, RESIDENCY_OPERATIONS, RESIDENCY_PERMISSIONS, RESIDENCY_SCHEMA_VERSION, RESIDENCY_REASONS,
    RESIDENCY_RULES, RESIDENCY_TIERS, MANIFEST_RESIDENT_TIERS, DEFAULT_HOT_BUDGET, ResidencyError,
    createResidencyTable, isResidencyTable, warmNode, loadNode, evictNode, dropNode, residencyOf, hotNodes,
    manifestResidentNodes, describeResidency, formatResidency, residencyCandidates, hotHeadroom,
  }).join(' ');
  for (const later of ['capabilit', 'trust', 'quarantine', 'health', 'pool', 'sandbox', 'attest', 'sbom', 'canary', 'fingerprint']) {
    assert.equal(new RegExp(later, 'i').test(names), false, `${later} belongs to a later milestone`);
  }
});
