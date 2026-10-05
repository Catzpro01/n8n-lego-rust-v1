/**
 * P6.4 — Dependency closure + content-addressed artifact store. Contract `registry.closure@0.1.0`.
 *
 * Matrix: catalogue and root validation (fail closed), version selection over
 * the documented semver subset, determinism (same catalogue + root ⇒ identical
 * order, versions and digest), the topological order an installer must follow,
 * every refusal that has burned a real supply chain (missing required,
 * unsatisfiable range, version conflict, declared conflict, cycle with the path
 * named, depth ceiling, size ceiling), optional semantics (absent is fine,
 * broken is reported), content addressing (identical bytes share one address),
 * tamper detection, store immutability, garbage collection that requires a live
 * set, closure-vs-store verification, and the P6.4 scope walls.
 *
 * Pure: the catalogue is data handed in, so the same resolution happens in a
 * test and on a ship. No filesystem, no network, no timers, no clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CLOSURE_MAX_DEPTH,
  CLOSURE_MAX_PACKAGES,
  DEPENDENCY_CLOSURE_CONTRACT,
  DEPENDENCY_CLOSURE_CONTRACT_VERSION,
  DEPENDENCY_CLOSURE_INPUT_SCHEMA_VERSION,
  DEPENDENCY_CLOSURE_OPERATIONS,
  DEPENDENCY_CLOSURE_PERMISSIONS,
  DEPENDENCY_CLOSURE_REASONS,
  DEPENDENCY_CLOSURE_RULES,
  DEPENDENCY_CLOSURE_SCHEMA_VERSION,
  DEPENDENCY_KINDS,
  DependencyClosureError,
  artifactStoreManifest,
  closureInstallPlan,
  collectArtifactGarbage,
  contentAddress,
  createArtifactStore,
  getArtifact,
  hasArtifact,
  isDependencyClosure,
  missingFromClosure,
  resolveDependencyClosure,
  storeArtifact,
  verifyArtifact,
  verifyClosureAgainstStore,
} from '../src/lego/dependency-closure.mjs';

const D = (char) => `sha256:${char.repeat(64)}`;
const pkg = (char, dependencies = []) => ({ digest: D(char), dependencies });
const resolve = (catalogue, root = { package: 'root' }, extra = {}) => resolveDependencyClosure({ root, catalogue, ...extra });

const SIMPLE = {
  root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '^1.0.0' }]) },
  leaf: { '1.0.0': pkg('2'), '1.4.0': pkg('3') },
};

/* ---------------------------------------------------------------- contract */

test('the contract identifies itself, is versioned and declares its bounds', () => {
  assert.equal(DEPENDENCY_CLOSURE_CONTRACT, 'registry.closure@0.1.0');
  assert.equal(DEPENDENCY_CLOSURE_CONTRACT_VERSION, '0.1.0');
  assert.equal(DEPENDENCY_CLOSURE_SCHEMA_VERSION, 1);
  assert.deepEqual([...DEPENDENCY_CLOSURE_OPERATIONS], ['resolve', 'store', 'verify', 'plan']);
  assert.deepEqual([...DEPENDENCY_KINDS], ['runtime', 'optional', 'peer', 'conflict']);
  assert.ok(DEPENDENCY_CLOSURE_PERMISSIONS.every((word) => typeof word === 'string'));
  assert.ok(CLOSURE_MAX_DEPTH >= 8 && CLOSURE_MAX_PACKAGES >= 128);
  assert.equal(DEPENDENCY_CLOSURE_INPUT_SCHEMA_VERSION, 1);
});

test('the refusal vocabulary is closed, prefixed and free of duplicates', () => {
  assert.ok(DEPENDENCY_CLOSURE_REASONS.length >= 10);
  assert.equal(new Set(DEPENDENCY_CLOSURE_REASONS).size, DEPENDENCY_CLOSURE_REASONS.length);
  assert.ok(DEPENDENCY_CLOSURE_REASONS.every((reason) => reason.startsWith('closure.')));
  assert.match(DEPENDENCY_CLOSURE_RULES.addressing, /IS the hash/);
  assert.match(DEPENDENCY_CLOSURE_RULES.optional, /may be ABSENT/);
  assert.match(DEPENDENCY_CLOSURE_RULES.authority, /nothing about authorship/);
});

/* --------------------------------------------------------------- catalogue */

test('a malformed catalogue is refused before any resolution happens', () => {
  assert.throws(() => resolve(null), DependencyClosureError);
  assert.throws(() => resolve({ 'Bad Name': { '1.0.0': pkg('1') } }), (error) => error.meta.code === 'closure.identity');
  assert.throws(() => resolve({ root: { 'v1': pkg('1') } }), (error) => error.meta.code === 'closure.identity');
  assert.throws(() => resolve({ root: 'nope' }), (error) => error.meta.code === 'closure.identity');
  assert.throws(() => resolve({ root: { '1.0.0': { dependencies: [] } } }), (error) => error.meta.code === 'closure.digest');
  assert.throws(() => resolve({ root: { '1.0.0': { digest: D('1'), dependencies: 'none' } } }), (error) => error.meta.code === 'closure.identity');
});

test('dependency edges are validated: kind, range and duplicates', () => {
  assert.throws(() => resolve({ root: { '1.0.0': pkg('1', [{ package: 'a', kind: 'wishful' }]) }, a: { '1.0.0': pkg('2') } }), (error) => error.meta.code === 'closure.identity');
  assert.throws(() => resolve({ root: { '1.0.0': pkg('1', [{ package: 'a', range: '>=1 <2' }]) }, a: { '1.0.0': pkg('2') } }), (error) => error.meta.code === 'closure.range');
  assert.throws(() => resolve({ root: { '1.0.0': pkg('1', [{ package: 'a' }, { package: 'a' }]) }, a: { '1.0.0': pkg('2') } }), (error) => error.meta.code === 'closure.duplicate');
  assert.throws(() => resolve({ root: { '1.0.0': pkg('1', [{}]) } }), (error) => error.meta.code === 'closure.identity');
});

test('a bad root or a bad depth bound is refused, not defaulted', () => {
  assert.throws(() => resolveDependencyClosure({ catalogue: SIMPLE }), (error) => error.meta.code === 'closure.identity');
  assert.throws(() => resolveDependencyClosure({ root: { package: 'Root' }, catalogue: SIMPLE }), (error) => error.meta.code === 'closure.identity');
  assert.throws(() => resolveDependencyClosure({ root: { package: 'root', range: '~>' }, catalogue: SIMPLE }), (error) => error.meta.code === 'closure.range');
  for (const maxDepth of [0, -1, 1.5, CLOSURE_MAX_DEPTH + 1, 'deep']) {
    assert.throws(() => resolve(SIMPLE, { package: 'root' }, { maxDepth }), (error) => error.meta.code === 'closure.depth');
  }
});

/* -------------------------------------------------------------- resolution */

test('a closure is resolved, ordered and frozen', () => {
  const closure = resolve(SIMPLE);
  assert.equal(closure.ok, true);
  assert.equal(closure.count, 2);
  assert.deepEqual([...closure.order], ['leaf@1.4.0', 'root@1.0.0'], 'a dependency is installed before what requires it');
  assert.equal(closure.packages['leaf'].version, '1.4.0');
  assert.equal(closure.packages['leaf'].depth, 1);
  assert.equal(closure.packages['leaf'].digest, D('3'));
  assert.deepEqual([...closure.packages['leaf'].requiredBy], ['root']);
  assert.equal(closure.root.package, 'root');
  assert.equal(closure.depth, 1);
  assert.ok(isDependencyClosure(closure));
  assert.ok(Object.isFrozen(closure) && Object.isFrozen(closure.order) && Object.isFrozen(closure.packages['root']));
});

test('resolution is deterministic: the same catalogue and root give the same digest', () => {
  const a = resolve(SIMPLE);
  const b = resolve(SIMPLE);
  assert.equal(a.digest, b.digest);
  // Declaration order inside the catalogue must not matter either.
  const shuffled = { leaf: SIMPLE.leaf, root: SIMPLE.root };
  assert.equal(resolve(shuffled).digest, a.digest);
  assert.deepEqual([...resolve(shuffled).order], [...a.order]);
});

test('the highest satisfying version wins, over the documented semver subset', () => {
  const catalogue = {
    root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '^1.0.0' }]) },
    leaf: { '1.0.0': pkg('2'), '1.4.0': pkg('3'), '2.0.0': pkg('4') },
  };
  assert.equal(resolve(catalogue).packages['leaf'].version, '1.4.0', 'caret stays inside the major');
  const tilde = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '~1.0.0' }]) },
    leaf: { '1.0.0': pkg('2'), '1.0.9': pkg('3'), '1.1.0': pkg('4') },
  });
  assert.equal(tilde.packages['leaf'].version, '1.0.9', 'tilde stays inside the minor');
  const exact = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '1.0.0' }]) },
    leaf: { '1.0.0': pkg('2'), '1.4.0': pkg('3') },
  });
  assert.equal(exact.packages['leaf'].version, '1.0.0', 'an exact requirement is exact');
  assert.equal(resolve({ root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '*' }]) }, leaf: { '9.0.0': pkg('2') } }).packages['leaf'].version, '9.0.0');
});

test('a pre-release is never selected unless the requirement names it', () => {
  const catalogue = {
    root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '^1.0.0' }]) },
    leaf: { '1.0.0': pkg('2'), '1.1.0-beta.1': pkg('3') },
  };
  assert.equal(resolve(catalogue).packages['leaf'].version, '1.0.0', 'a beta must not be picked up by a caret range');
  const explicit = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '1.1.0-beta.1' }]) },
    leaf: { '1.0.0': pkg('2'), '1.1.0-beta.1': pkg('3') },
  });
  assert.equal(explicit.packages['leaf'].version, '1.1.0-beta.1');
});

test('a deep chain resolves and its depth is reported', () => {
  const catalogue = {};
  for (let index = 0; index < 6; index += 1) {
    catalogue[index === 0 ? 'root' : `pkg-${index}`] = {
      '1.0.0': pkg('a', index < 5 ? [{ package: `pkg-${index + 1}`, range: '^1.0.0' }] : []),
    };
  }
  const closure = resolve(catalogue);
  assert.equal(closure.ok, true);
  assert.equal(closure.count, 6);
  assert.equal(closure.depth, 5);
  assert.equal(closure.order[0], 'pkg-5@1.0.0', 'the deepest dependency is installed first');
});

/* --------------------------------------------------------------- refusals */

test('a missing required dependency fails the whole closure', () => {
  const closure = resolve({ root: { '1.0.0': pkg('1', [{ package: 'ghost' }]) } });
  assert.equal(closure.ok, false);
  assert.equal(closure.reason, 'closure.missing');
  assert.deepEqual([...closure.order], []);
  assert.equal(closure.packages.ghost, undefined, 'no partial closure is handed back');
  assert.match(closure.errors[0].message, /not published in the catalogue/);
});

test('an unsatisfiable range is refused instead of picking a nearby version', () => {
  const closure = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'leaf', range: '^9.0.0' }]) },
    leaf: { '1.0.0': pkg('2') },
  });
  assert.equal(closure.ok, false);
  assert.equal(closure.reason, 'closure.unsatisfied');
  assert.match(closure.errors[0].message, /no published version satisfies it/);
});

test('the root itself must exist and satisfy its range', () => {
  assert.equal(resolve({ leaf: { '1.0.0': pkg('2') } }).reason, 'closure.missing');
  assert.equal(resolve(SIMPLE, { package: 'root', range: '^9.0.0' }).reason, 'closure.unsatisfied');
});

test('two requirements no single version satisfies are a conflict, not a preference', () => {
  const closure = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'left' }, { package: 'right' }]) },
    left: { '1.0.0': pkg('2', [{ package: 'shared', range: '^1.0.0' }]) },
    right: { '1.0.0': pkg('3', [{ package: 'shared', range: '^2.0.0' }]) },
    shared: { '1.1.0': pkg('4'), '2.1.0': pkg('5') },
  });
  assert.equal(closure.ok, false);
  assert.ok(['closure.unsatisfied', 'closure.conflict'].includes(closure.reason));
  assert.match(closure.errors[0].message, /shared/);
});

test('a declared conflict with something the closure requires is refused', () => {
  const closure = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'rival', kind: 'conflict' }, { package: 'leaf' }]) },
    leaf: { '1.0.0': pkg('2', [{ package: 'rival' }]) },
    rival: { '1.0.0': pkg('3') },
  });
  assert.equal(closure.ok, false);
  assert.equal(closure.reason, 'closure.conflict');
  assert.match(closure.errors[0].message, /declares a conflict with 'rival'/);
});

test('a conflict with something the closure does NOT require is harmless', () => {
  const closure = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'rival', kind: 'conflict' }]) },
    rival: { '1.0.0': pkg('3') },
  });
  assert.equal(closure.ok, true);
  assert.deepEqual([...closure.order], ['root@1.0.0'], 'a conflict is not a requirement');
});

test('a cycle is refused with the path named — a closure must be orderable', () => {
  const closure = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'a' }]) },
    a: { '1.0.0': pkg('2', [{ package: 'b' }]) },
    b: { '1.0.0': pkg('3', [{ package: 'a' }]) },
  });
  assert.equal(closure.ok, false);
  assert.equal(closure.reason, 'closure.cycle');
  assert.deepEqual([...closure.errors[0].cycle], ['a', 'b', 'a']);
  assert.match(closure.errors[0].message, /cannot be ordered/);
});

test('a graph deeper than the ceiling is refused, and the ceiling is honoured', () => {
  const catalogue = {};
  for (let index = 0; index < 10; index += 1) {
    catalogue[index === 0 ? 'root' : `pkg-${index}`] = { '1.0.0': pkg('a', [{ package: `pkg-${index + 1}` }]) };
  }
  catalogue['pkg-10'] = { '1.0.0': pkg('a') };
  assert.equal(resolve(catalogue, { package: 'root' }, { maxDepth: 3 }).reason, 'closure.depth');
  assert.equal(resolve(catalogue, { package: 'root' }, { maxDepth: 12 }).ok, true, 'a ceiling above the real depth is satisfied, not tripped');
});

test('a closure wider than the ceiling is refused rather than walked', () => {
  const catalogue = { root: { '1.0.0': pkg('1', Array.from({ length: CLOSURE_MAX_PACKAGES + 1 }, (_, index) => ({ package: `wide-${index}` }))) } };
  for (let index = 0; index <= CLOSURE_MAX_PACKAGES; index += 1) catalogue[`wide-${index}`] = { '1.0.0': pkg('a') };
  const closure = resolve(catalogue);
  assert.equal(closure.ok, false);
  assert.equal(closure.reason, 'closure.size');
  assert.match(closure.errors.at(-1).message, new RegExp(String(CLOSURE_MAX_PACKAGES)));
});

/* ---------------------------------------------------------------- optional */

test('an absent optional dependency is reported, not fatal', () => {
  const closure = resolve({ root: { '1.0.0': pkg('1', [{ package: 'extra', kind: 'optional' }]) } });
  assert.equal(closure.ok, true);
  assert.deepEqual([...closure.order], ['root@1.0.0']);
  assert.equal(closure.optionalMissing.length, 1);
  assert.equal(closure.optionalMissing[0].package, 'extra');
  assert.equal(closure.optionalMissing[0].reason, 'absent');
});

test('an optional dependency that IS present is installed and marked optional', () => {
  const closure = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'extra', kind: 'optional' }]) },
    extra: { '1.0.0': pkg('2') },
  });
  assert.equal(closure.ok, true);
  assert.equal(closure.optionalMissing.length, 0);
  assert.equal(closure.packages.extra.kind, 'optional');
  assert.deepEqual([...closure.order], ['extra@1.0.0', 'root@1.0.0']);
});

test('an optional dependency declared with an impossible range is reported as broken', () => {
  const closure = resolve({
    root: { '1.0.0': pkg('1', [{ package: 'extra', kind: 'optional', range: '^9.0.0' }]) },
    extra: { '1.0.0': pkg('2') },
  });
  assert.equal(closure.ok, true);
  assert.equal(closure.optionalMissing[0].reason, 'range', 'optional means "may be absent", not "may be wrong"');
  assert.equal(closure.optionalMissing[0].range, '^9.0.0');
});

/* ------------------------------------------------------------ plan / deltas */

test('the install plan is ordered, complete and frozen', () => {
  const plan = closureInstallPlan(resolve(SIMPLE));
  assert.deepEqual(plan.map((entry) => entry.identity), ['leaf@1.4.0', 'root@1.0.0']);
  assert.equal(plan[0].digest, D('3'));
  assert.equal(plan[1].depth, 0);
  assert.ok(plan.every((entry) => ['runtime', 'optional'].includes(entry.kind)));
  assert.throws(() => closureInstallPlan({ ok: true }), DependencyClosureError);
});

test('missingFromClosure reports exactly what is not installed', () => {
  const closure = resolve(SIMPLE);
  assert.deepEqual([...missingFromClosure(closure, ['leaf@1.4.0'])], ['root@1.0.0']);
  assert.deepEqual([...missingFromClosure(closure, new Set(['leaf@1.4.0', 'root@1.0.0']))], []);
  assert.throws(() => missingFromClosure(closure, 'leaf@1.4.0'), DependencyClosureError);
});

/* ----------------------------------------------------- content addressing */

test('an address IS the hash of the content, for text, bytes and objects', () => {
  assert.match(contentAddress('hello'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(contentAddress('hello'), contentAddress('hello'));
  assert.notEqual(contentAddress('hello'), contentAddress('hello!'));
  assert.equal(contentAddress(new Uint8Array([1, 2, 3])), contentAddress(new Uint8Array([1, 2, 3])));
  assert.notEqual(contentAddress(new Uint8Array([1, 2, 3])), contentAddress(new Uint8Array([3, 2, 1])));
  assert.equal(contentAddress({ a: 1, b: 2 }), contentAddress({ b: 2, a: 1 }), 'key order must not move an address');
  assert.throws(() => contentAddress(undefined), (error) => error.meta.code === 'closure.address');
});

test('storing is content-addressed and immutable: identical bytes dedupe', () => {
  const empty = createArtifactStore();
  const first = storeArtifact(empty, 'payload');
  assert.equal(first.stored, true);
  assert.equal(first.deduplicated, false);
  assert.equal(first.store.count, 1);
  assert.equal(empty.count, 0, 'the store handed in is untouched');
  const second = storeArtifact(first.store, 'payload');
  assert.equal(second.stored, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.address, first.address);
  assert.equal(second.store.count, 1, 'one address, one entry — deduplication is safe because the address IS the content');
  assert.equal(second.store.deduplicated, 1);
  assert.ok(Object.isFrozen(first.store) && Object.isFrozen(first.store.addresses));
});

test('a store is read back by address, and by nothing else', () => {
  const { store, address } = storeArtifact(createArtifactStore(), 'payload');
  assert.equal(hasArtifact(store, address), true);
  assert.equal(hasArtifact(store, D('f')), false);
  assert.equal(getArtifact(store, address).size, 7);
  assert.equal(getArtifact(store, address).kind, 'text');
  assert.equal(getArtifact(store, D('f')), null);
  assert.throws(() => hasArtifact({ ok: true }, address), DependencyClosureError);
});

test('verification accepts intact content and refuses corruption instead of re-addressing it', () => {
  const { store, address } = storeArtifact(createArtifactStore(), 'payload');
  assert.equal(verifyArtifact(store, address, 'payload').ok, true);
  const tampered = verifyArtifact(store, address, 'payloaD');
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, 'closure.digest');
  assert.match(tampered.message, /corruption is not an upgrade/);
  assert.notEqual(tampered.actual, tampered.expected);
  // Original content is still what the store holds — nothing was rewritten.
  assert.equal(hasArtifact(store, address), true);
  assert.equal(verifyArtifact(store, address, 'payload').ok, true);
});

test('verification refuses a malformed address and content that is not in this store', () => {
  const { store } = storeArtifact(createArtifactStore(), 'payload');
  assert.equal(verifyArtifact(store, 'payload', 'payload').reason, 'closure.address');
  const unknown = verifyArtifact(store, contentAddress('elsewhere'), 'elsewhere');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'closure.store');
  assert.match(unknown.message, /not in this store/);
});

test('the store manifest is sorted, deterministic and counts deduplication', () => {
  let store = createArtifactStore();
  store = storeArtifact(store, 'b').store;
  store = storeArtifact(store, 'a').store;
  store = storeArtifact(store, 'a').store;
  const manifest = artifactStoreManifest(store);
  assert.equal(manifest.count, 2);
  assert.deepEqual(manifest.addresses, [...manifest.addresses].sort());
  assert.equal(manifest.deduplicated, 1);
  assert.equal(manifest.digest, artifactStoreManifest(store).digest);
  assert.equal(Object.keys(manifest.sizes).length, 2);
});

test('garbage collection requires a live set and never guesses', () => {
  let store = createArtifactStore();
  const live = storeArtifact(store, 'live').address;
  store = storeArtifact(store, 'live').store;
  store = storeArtifact(store, 'dead').store;
  assert.throws(() => collectArtifactGarbage(store, undefined), (error) => error.meta.code === 'closure.store');
  const collected = collectArtifactGarbage(store, [live]);
  assert.equal(collected.removed.length, 1);
  assert.equal(hasArtifact(collected.store, live), true, 'a live address is never touched');
  assert.equal(collected.store.count, 1);
  const nothing = collectArtifactGarbage(collected.store, [live]);
  assert.deepEqual([...nothing.removed], []);
  assert.equal(nothing.store, collected.store);
});

test('a closure is verified against a store as a whole', () => {
  const closure = resolve(SIMPLE);
  let store = createArtifactStore();
  const check = verifyClosureAgainstStore(closure, store);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'closure.store');
  assert.equal(check.missing.length, 2);
  assert.match(check.message, /2 of 2 packages/);
  // The closure carries digests of the form the store addresses.
  store = storeArtifact(store, 'anything').store;
  const stillMissing = verifyClosureAgainstStore(closure, store);
  assert.equal(stillMissing.missing.length, 2, 'a store containing unrelated content does not satisfy a closure');
});

/* --------------------------------------------------------------- walls */

test('every read refuses a value this contract did not produce', () => {
  for (const fn of [closureInstallPlan, missingFromClosure, verifyClosureAgainstStore]) {
    assert.throws(() => fn({ ok: true, contract: DEPENDENCY_CLOSURE_CONTRACT, schemaVersion: 1, order: [], packages: {}, digest: 'x' }, createArtifactStore()), DependencyClosureError);
  }
  assert.equal(isDependencyClosure({ ...resolve(SIMPLE) }), false, 'a shallow copy is not a closure');
  assert.equal(isDependencyClosure(JSON.parse(JSON.stringify(resolve(SIMPLE)))), false);
});

test('P6.4 publishes exactly one contract row and does not re-version P6.3', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'registry.closure');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, DEPENDENCY_CLOSURE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.deepEqual(rows[0].surface, ['src/lego/dependency-closure.mjs']);
  assert.equal(lock.contracts.filter((contract) => contract.id === 'package.transaction')[0].version, '0.1.0');
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/dependency-closure.mjs'));
});

test('the module is pure: the catalogue is data, not a network call', () => {
  const source = readFileSync(new URL('../src/lego/dependency-closure.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.']) {
    assert.equal(code.includes(forbidden), false, `dependency closure must not reference ${forbidden}`);
  }
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'resolution must not read a clock');
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
});

test('P6.4 scope walls: no install, no lease, no trust, no attestation', () => {
  const names = Object.keys({
    DEPENDENCY_CLOSURE_CONTRACT, DEPENDENCY_CLOSURE_OPERATIONS, DEPENDENCY_CLOSURE_PERMISSIONS,
    DEPENDENCY_CLOSURE_SCHEMA_VERSION, DEPENDENCY_CLOSURE_REASONS, DEPENDENCY_CLOSURE_RULES, DEPENDENCY_KINDS,
    CLOSURE_MAX_DEPTH, CLOSURE_MAX_PACKAGES, DependencyClosureError, resolveDependencyClosure, isDependencyClosure,
    closureInstallPlan, missingFromClosure, contentAddress, createArtifactStore, storeArtifact, hasArtifact,
    getArtifact, verifyArtifact, artifactStoreManifest, collectArtifactGarbage, verifyClosureAgainstStore,
  }).join(' ');
  for (const later of ['journal', 'fence', 'lease', 'residency', 'quarantine', 'attest', 'sbom', 'canary', 'signature', 'trust']) {
    assert.equal(new RegExp(later, 'i').test(names), false, `${later} belongs to a later milestone`);
  }
  const source = readFileSync(new URL('../src/lego/dependency-closure.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/node-registry\.mjs'/);
});
