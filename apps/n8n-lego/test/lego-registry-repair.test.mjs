/**
 * P6.30 — repair assessment, ordered restoration and offline recovery.
 * Contract `registry.repair@0.1.0`.
 *
 * Matrix: the surface, expectations, censuses and their own hashes, the damage census, the order,
 * the plan (offline, blocked, quarantine, dependencies), staleness, verification, determinism and
 * the reads, the walls, and the lock row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ITEM_STATES,
  REGISTRY_REPAIR_CONTRACT,
  REGISTRY_REPAIR_CONTRACT_VERSION,
  REGISTRY_REPAIR_FORMAT,
  REGISTRY_REPAIR_SCHEMA_VERSION,
  REPAIR_OPERATIONS,
  REPAIR_PERMISSIONS,
  REPAIR_REASONS,
  REPAIR_RULES,
  REPAIR_SOURCES,
  REPAIR_VERDICTS,
  RepairError,
  assessRegistry,
  createExpectation,
  describeRepair,
  explainRepair,
  isCensus,
  isExpectation,
  itemDigest,
  observeRegistry,
  planRepair,
  repairDigest,
  repairOrder,
  stableJson,
  verifyRepair,
} from '../src/lego/registry-repair.mjs';

/* ------------------------------------------------------------------ fixtures */

const ALPHA = itemDigest('alpha');
const BETA = itemDigest('beta');
const GAMMA = itemDigest('gamma');

const EXPECTED = () => createExpectation({
  epoch: 'e2',
  items: [{ name: 'a', digest: ALPHA }, { name: 'b', digest: BETA }, { name: 'c', digest: GAMMA }],
});

const INTACT_CENSUS = () => observeRegistry({
  epoch: 'e2',
  items: [
    { name: 'a', digest: ALPHA, bytes: 'alpha', source: 'local-store' },
    { name: 'b', digest: BETA, bytes: 'beta', source: 'local-store' },
    { name: 'c', digest: GAMMA, bytes: 'gamma', source: 'local-store' },
  ],
});

/** `a` intact, `b` altered, `c` missing, and one file nothing expected. */
const DAMAGED_CENSUS = () => observeRegistry({
  epoch: 'e2',
  items: [
    { name: 'a', digest: ALPHA, bytes: 'alpha', source: 'local-store' },
    { name: 'b', digest: itemDigest('beta-tampered'), bytes: 'beta-tampered', source: 'local-store' },
    { name: 'stray', digest: itemDigest('stray') },
  ],
});

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof RepairError, `expected a RepairError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(REGISTRY_REPAIR_CONTRACT, 'registry.repair@0.1.0');
  assert.equal(REGISTRY_REPAIR_CONTRACT_VERSION, '0.1.0');
  assert.equal(REGISTRY_REPAIR_SCHEMA_VERSION, 1);
  assert.equal(REGISTRY_REPAIR_FORMAT, 'lego-repair@1');
  assert.deepEqual([...REPAIR_OPERATIONS], ['assess', 'plan', 'order', 'verify', 'describe']);
  assert.deepEqual([...REPAIR_PERMISSIONS], ['node:read']);
  assert.deepEqual([...REPAIR_VERDICTS], ['intact', 'recoverable', 'blocked']);
  assert.deepEqual([...ITEM_STATES], ['intact', 'altered', 'missing', 'unexpected']);
  assert.deepEqual([...REPAIR_SOURCES], ['local-store', 'mirror']);
  assert.equal(REPAIR_REASONS.length, 8);
  assert.match(REPAIR_RULES.keep, /does not delete what it did not put there/);
  assert.match(REPAIR_RULES.stale, /a rollback wearing a recovery's clothes/);
  assert.match(REPAIR_RULES.authority, /it never fetches/);
});

test('an expectation is digests, and a census that contradicts its own hashes is refused', () => {
  const expected = EXPECTED();
  assert.equal(isExpectation(expected), true);
  assert.equal(Object.isFrozen(expected), true);
  assert.equal(expected.epoch, 'e2');
  assert.deepEqual(expected.items.map((item) => item.name), ['a', 'b', 'c']);
  const { expectationDigest, ...body } = expected;
  assert.equal(expectationDigest, repairDigest(body));
  assert.equal(itemDigest('alpha'), ALPHA);
  assert.equal(itemDigest({ b: 1, a: 2 }), itemDigest({ a: 2, b: 1 }), 'a digest is over content, not over key order');
  assert.equal(stableJson({ b: 1, a: 2 }), stableJson({ a: 2, b: 1 }));
  assert.equal(assessRegistry({ expected, observed: INTACT_CENSUS() }).expectedEpoch, 'e2');

  assert.match(throwsWith(() => createExpectation({ epoch: 'e2', items: [] }), 'repair.item').message, /a repair with nothing to compare against is a wish/);
  throwsWith(() => createExpectation({ epoch: '', items: [{ name: 'a', digest: ALPHA }] }), 'repair.input');
  throwsWith(() => createExpectation({ epoch: 'e2', items: [{ digest: ALPHA }] }), 'repair.item');
  throwsWith(() => createExpectation({ epoch: 'e2', items: [{ name: 'a' }] }), 'repair.item');
  assert.match(throwsWith(() => createExpectation({ epoch: 'e2', items: [{ name: 'a', digest: ALPHA }, { name: 'a', digest: BETA }] }), 'repair.item').message, /names 'a' twice/);

  assert.equal(isCensus(INTACT_CENSUS()), true);
  assert.equal(isCensus({ epoch: 'e1' }), false);
  throwsWith(() => observeRegistry({}), 'repair.input');
  throwsWith(() => observeRegistry({ epoch: 'e2', items: [{ name: 'a' }] }), 'repair.item');
  throwsWith(() => observeRegistry({ epoch: 'e2', items: [{ name: 'a', digest: ALPHA }, { name: 'a', digest: ALPHA }] }), 'repair.item');
  throwsWith(() => observeRegistry({ epoch: 'e2', items: [{ name: 'a', digest: ALPHA, source: 'ftp' }] }), 'repair.input');
  assert.match(
    throwsWith(() => observeRegistry({ epoch: 'e2', items: [{ name: 'a', digest: ALPHA, bytes: 'not-alpha' }] }), 'repair.input').message,
    /reports [0-9a-f]{12}… and its bytes hash to [0-9a-f]{12}…: an item that does not hash to its own digest is not evidence/,
  );
  assert.equal(observeRegistry({ epoch: 'e2', items: [] }).items.length, 0, 'a wiped install is a census, and it has no items');
  throwsWith(() => itemDigest(null), 'repair.input');
});

/* --------------------------------------------------------------- assessment */

test('the damage census names what is intact, altered, missing and unexpected', () => {
  const assessed = assessRegistry({ expected: EXPECTED(), observed: DAMAGED_CENSUS() });
  assert.equal(assessed.ok, false);
  assert.equal(assessed.verdict, 'recoverable');
  assert.deepEqual([...assessed.states.intact], ['a']);
  assert.deepEqual([...assessed.states.altered], ['b']);
  assert.deepEqual([...assessed.states.missing], ['c']);
  assert.deepEqual([...assessed.states.unexpected], ['stray']);
  assert.deepEqual({ ...assessed.counts }, { intact: 1, altered: 1, missing: 1, unexpected: 1 });
  assert.match(assessed.message, /^1 altered, 1 missing and 1 unexpected item\(s\) against 3 expected$/);
  const { assessmentDigest, ok, message, ...body } = assessed;
  assert.equal(assessmentDigest, repairDigest(body), 'the digest covers the census, not the sentence about it');
  assert.match(explainRepair(assessed), /^RECOVERABLE — /);

  const good = assessRegistry({ expected: EXPECTED(), observed: INTACT_CENSUS() });
  assert.equal(good.ok, true);
  assert.equal(good.verdict, 'intact');
  assert.match(good.message, /the registry is at epoch 'e2' and every one of the 3 expected item\(s\) matches its digest/);

  const extras = assessRegistry({ expected: EXPECTED(), observed: observeRegistry({ epoch: 'e2', items: [{ name: 'a', digest: ALPHA }, { name: 'b', digest: BETA }, { name: 'c', digest: GAMMA }, { name: 'stray', digest: itemDigest('stray') }] }) });
  assert.equal(extras.verdict, 'intact', 'an extra file is not damage to another file — it is reported, not hidden');
  assert.equal(extras.ok, true);
  assert.match(extras.message, /with 1 unexpected item\(s\) reported/);

  throwsWith(() => assessRegistry({}), 'repair.input');
  throwsWith(() => assessRegistry({ expected: EXPECTED(), observed: {} }), 'repair.input');
});

/* -------------------------------------------------------------------- order */

test('restoration follows dependencies rather than the alphabet, and a cycle is not an order', () => {
  assert.deepEqual([...repairOrder({ items: ['b', 'a'] })], ['a', 'b']);
  assert.deepEqual([...repairOrder({ items: ['c', 'b', 'a'], dependencies: { c: ['b'], b: ['a'] } })], ['a', 'b', 'c']);
  assert.deepEqual([...repairOrder({ items: ['x', 'y', 'z'], dependencies: { z: ['x'], y: ['x'] } })], ['x', 'y', 'z']);
  assert.deepEqual([...repairOrder({ items: [] })], []);
  assert.deepEqual([...repairOrder({ items: ['a'], dependencies: { ghost: ['a'] } })], ['a'], 'a dependency outside the set being ordered is not part of the order');

  assert.match(
    throwsWith(() => repairOrder({ items: ['a', 'b'], dependencies: { a: ['b'], b: ['a'] } }), 'repair.order').message,
    /a cycle is not an order: a, b are waiting on each other/,
  );
  assert.match(
    throwsWith(() => repairOrder({ items: ['a'], dependencies: { a: ['ghost'] } }), 'repair.order').message,
    /'a' needs 'ghost', which is not part of this repair: an order over a set that is not closed cannot be computed/,
  );
  throwsWith(() => repairOrder({ items: ['a', 'a'] }), 'repair.order');
  throwsWith(() => repairOrder({ items: 'a' }), 'repair.order');
  throwsWith(() => repairOrder({ items: ['a'], dependencies: [] }), 'repair.order');
  throwsWith(() => repairOrder({ items: ['a'], dependencies: { a: 'b' } }), 'repair.order');
});

/* --------------------------------------------------------------------- plan */

test('a repair is offline unless the caller says otherwise, and an offline repair may not use a mirror', () => {
  const expected = EXPECTED();
  const observed = DAMAGED_CENSUS();

  const blockedOffline = planRepair({ expected, observed, policy: { available: { b: 'local-store' } } });
  assert.equal(blockedOffline.ok, false);
  assert.equal(blockedOffline.verdict, 'blocked');
  assert.equal(blockedOffline.offline, true, 'offline is the default, because assuming a network is how an offline repair becomes partial');
  assert.deepEqual(blockedOffline.blocked.map((entry) => `${entry.name}:${entry.reason}`), ['c:repair.missing']);
  assert.match(blockedOffline.message, /the repair is blocked on 'c' \(repair\.missing\): 1 step\(s\) are still planned and are not a repair on their own/);

  const mirrorRefused = planRepair({ expected, observed, policy: { available: { b: 'local-store', c: 'mirror' } } });
  assert.equal(mirrorRefused.verdict, 'blocked');
  assert.deepEqual(mirrorRefused.blocked.map((entry) => entry.reason), ['repair.offline']);
  assert.match(mirrorRefused.blocked[0].message, /this repair is offline and the only source for 'c' is a mirror/);

  const online = planRepair({ expected, observed, policy: { offline: false, available: { b: 'local-store', c: 'mirror' } } });
  assert.equal(online.ok, true);
  assert.equal(online.verdict, 'recoverable');
  assert.equal(online.offline, false);
  assert.deepEqual(online.steps.map((step) => `${step.action}:${step.name}:${step.source}`), ['restore:b:local-store', 'restore:c:mirror', 'quarantine:stray:null']);
  assert.deepEqual([...online.intact], ['a']);
  assert.match(online.message, /2 item\(s\) to restore and 1 to quarantine, online, from the sources named/);
  for (const step of online.steps) assert.notEqual(step.action, 'delete');
  assert.match(online.steps[2].message, /a repair does not delete what it did not put there/);
  assert.equal(online.steps[0].reason, 'repair.altered');
  assert.equal(online.steps[1].reason, 'repair.missing');
  assert.equal(online.steps[1].digest, GAMMA, 'a restore names the digest it is restoring to');

  const nothing = planRepair({ expected, observed: INTACT_CENSUS() });
  assert.equal(nothing.verdict, 'intact');
  assert.equal(nothing.ok, true);
  assert.equal(nothing.steps.length, 0);
  assert.match(nothing.message, /the registry matches epoch 'e2': nothing to repair$/);
});

test('a repair that cannot be done is blocked by name, and a superseded epoch is refused outright', () => {
  const expected = EXPECTED();
  const observes = observeRegistry({ epoch: 'e2', items: [{ name: 'a', digest: itemDigest('alpha') }] });
  const blocked = planRepair({ expected, observed: observes, policy: { available: {} } });
  assert.equal(blocked.verdict, 'blocked');
  assert.deepEqual(blocked.blocked.map((entry) => entry.name), ['b', 'c']);
  assert.match(blocked.blocked[0].message, /nothing has the bytes for 'b': a repair cannot invent content it has never seen/);

  const stale = planRepair({ expected, observed: observeRegistry({ epoch: 'e0', items: [{ name: 'a', digest: ALPHA }] }), policy: { supersededEpochs: ['e0'] } });
  assert.equal(stale.verdict, 'blocked');
  assert.equal(stale.reason, 'repair.stale');
  assert.equal(stale.steps.length, 0, 'no partial plan is produced for a stale census');
  assert.match(stale.message, /the census is at epoch 'e0', which has been superseded: repairing to an epoch that has been superseded is a rollback wearing a recovery's clothes/);

  const dependencies = planRepair({
    expected: createExpectation({ epoch: 'e2', items: [{ name: 'a', digest: ALPHA }, { name: 'b', digest: BETA }] }),
    observed: observeRegistry({ epoch: 'e2', items: [] }),
    dependencies: { b: ['a'], a: ['ghost'] },
    policy: { available: { a: 'local-store', b: 'local-store' } },
  });
  assert.equal(dependencies.verdict, 'recoverable');
  assert.deepEqual(dependencies.steps.map((step) => step.name), ['a', 'b'], 'a wiped install comes back in dependency order');

  throwsWith(() => planRepair({}), 'repair.input');
  throwsWith(() => planRepair({ expected: EXPECTED(), observed: INTACT_CENSUS(), policy: { offline: 'yes' } }), 'repair.input');
  throwsWith(() => planRepair({ expected: EXPECTED(), observed: INTACT_CENSUS(), policy: { supersededEpochs: [1] } }), 'repair.input');
  throwsWith(() => planRepair({ expected: EXPECTED(), observed: INTACT_CENSUS(), policy: { available: { a: 'ftp' } } }), 'repair.input');
  throwsWith(() => planRepair({ expected: EXPECTED(), observed: INTACT_CENSUS(), policy: [] }), 'repair.input');
});

/* ---------------------------------------------------------------- verifying */

test('part of the way back is not back, and the answer says how far short', () => {
  const verified = verifyRepair({ expected: EXPECTED(), observed: INTACT_CENSUS() });
  assert.equal(verified.ok, true);
  assert.equal(verified.verdict, 'verified');
  assert.deepEqual([...verified.remaining], []);
  assert.match(verified.message, /every item the expectation names is present at epoch 'e2' and matches its digest/);
  assert.match(verified.repairDigest, /^[0-9a-f]{64}$/);

  const partial = verifyRepair({ expected: EXPECTED(), observed: DAMAGED_CENSUS() });
  assert.equal(partial.ok, false);
  assert.equal(partial.verdict, 'partial');
  assert.deepEqual([...partial.remaining], ['b', 'c']);
  assert.match(partial.message, /2 item\(s\) still do not match \(b, c\): a registry that is part of the way back is not a registry that works/);

  throwsWith(() => verifyRepair({}), 'repair.input');
});

test('the same census gives the same plan, and the plan says what it will do', () => {
  const expected = EXPECTED();
  const observed = DAMAGED_CENSUS();
  const policy = { offline: false, available: { b: 'local-store', c: 'mirror' } };
  const first = planRepair({ expected, observed, policy });
  const second = planRepair({ expected, observed, policy });
  assert.equal(first.planDigest, second.planDigest);
  assert.notEqual(first.planDigest, planRepair({ expected, observed, policy: { ...policy, offline: true } }).planDigest, 'a plan names the conditions it was made under');

  const described = describeRepair(first);
  assert.equal(described.format, REGISTRY_REPAIR_FORMAT);
  assert.equal(described.verdict, 'recoverable');
  assert.equal(described.offline, false);
  assert.deepEqual({ ...described.actions }, { restore: 2, quarantine: 1 });
  assert.equal(described.intact, 1);
  assert.deepEqual([...described.names], ['restore:b', 'restore:c', 'quarantine:stray']);
  assert.deepEqual([...described.blocked], []);
  assert.equal(described.planDigest, first.planDigest);
  assert.match(described.message, /2 to restore, 1 to quarantine, 1 already intact \(online\)/);

  const blockedPlan = describeRepair(planRepair({ expected, observed, policy: { available: {} } }));
  assert.deepEqual([...blockedPlan.blocked], ['b (repair.missing)', 'c (repair.missing)']);
  assert.match(blockedPlan.message, /blocked: 2 item\(s\) cannot be put back and 0 restorable step\(s\) wait on them/);

  throwsWith(() => describeRepair({}), 'repair.input');
  throwsWith(() => explainRepair({}), 'repair.input');
  assert.equal(explainRepair(verifyRepair({ expected, observed: INTACT_CENSUS() })), 'VERIFIED — every item the expectation names is present at epoch \'e2\' and matches its digest');
});

/* --------------------------------------------------------------------- walls */

test('the repair contract decides what is missing: it fetches nothing and serves nothing', () => {
  const source = readFileSync(new URL('../src/lego/registry-repair.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(', 'createSign', 'subtle']) {
    assert.equal(code.includes(forbidden), false, `the repair contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./artifact-store.mjs', './registry-integrity.mjs', './node-registry.mjs', './freshness.mjs', './namespace-confusion.mjs', './admission-explain.mjs', './supply-chain.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.30 must not reach into ${forbidden}: the store is P6.7 and the epoch chain is P6.16`);
  }
  for (const name of ['createArtifactStore', 'storeArtifact', 'appendEpoch', 'checkFreshness', 'evaluateFreshness', 'NODE_TRUST_CLASSES', 'signAttestation', 'resolveName', 'verifyAcceptanceReport']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone: repair is not storage, freshness or trust`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'registry.repair');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, REGISTRY_REPAIR_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/registry-repair.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-registry-repair.test.mjs']);
  for (const name of ['createExpectation', 'observeRegistry', 'assessRegistry', 'repairOrder', 'planRepair', 'verifyRepair', 'describeRepair']) {
    assert.equal(rows[0].exports['src/lego/registry-repair.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'node.namespace', 'registry.freshness', 'node.provenance', 'node.abi', 'runtime.wasm-cache', 'node.admission']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.30 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/registry-repair.mjs'));
});
