/**
 * P6.2 — Registry compiler + immutable epoch. Contract `registry.compiler@0.1.0`.
 *
 * Matrix: determinism (key order / declaration order / capability order),
 * all-or-nothing compile (invalid + duplicate → no epoch), monotonic epoch
 * numbering, lineage (parent digest, chain), rollback that never rewinds the
 * counter, atomic non-mutating publication, integrity verification (tamper
 * detection), diff, immutability (deep freeze), and the scope walls that keep
 * this milestone out of P6.3+ territory.
 *
 * Pure: no filesystem, no network, no process, no timers, no clock, no
 * randomness. Every digest here is reproducible on any host, and the tests
 * prove it by recompiling rather than by trusting a stored constant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  REGISTRY_COMPILER_CONTRACT,
  REGISTRY_COMPILER_CONTRACT_VERSION,
  REGISTRY_COMPILER_SCHEMA_VERSION,
  REGISTRY_COMPILER_OPERATIONS,
  REGISTRY_COMPILER_PERMISSIONS,
  REGISTRY_COMPILER_REASONS,
  REGISTRY_COMPILER_RULES,
  REGISTRY_EPOCH_GENESIS,
  REGISTRY_EPOCH_ORIGINS,
  REGISTRY_EPOCH_SOURCE_MAX_LENGTH,
  REGISTRY_COMPILER_INPUT_SCHEMA_VERSION,
  RegistryCompilerError,
  compileRegistryEpoch,
  describeRegistryEpoch,
  diffRegistryEpochs,
  epochChainOf,
  epochEntryOf,
  epochIdentityOf,
  epochManifest,
  formatRegistryEpoch,
  freezeRegistryEpoch,
  isFrozenRegistryEpoch,
  nextRegistryEpoch,
  publishRegistryEpoch,
  rollbackRegistryEpoch,
  verifyRegistryEpoch,
} from '../src/lego/registry-compiler.mjs';

const SOURCE = 'catalog:n8n-nodes-base@2.9.1';

function declaration(overrides = {}) {
  return {
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    package: 'n8n-nodes-base',
    packageVersion: '2.9.1',
    vendor: 'n8n',
    contractVersion: '0.1.0',
    implementationVersion: '0.1.0',
    digest: `sha256:${'a'.repeat(64)}`,
    provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@2.9.1' },
    capabilities: ['network'],
    trustClass: 'core',
    runtimeLocality: 'js-compat',
    resourceProfile: {
      cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast',
    },
    compatibility: { contractRange: '^0.1.0', portabilityTargets: ['JS'] },
    lifecycle: 'declared',
    health: 'unknown',
    discovery: { displayName: 'HTTP Request', group: 'input', description: 'Makes an HTTP request' },
    ...overrides,
  };
}

const second = () => declaration({
  type: 'n8n-nodes-base.set',
  typeVersion: 3.4,
  discovery: { displayName: 'Edit Fields', group: 'transform', description: 'Sets fields' },
  capabilities: ['filesystem'],
});

const compile = (declarations, extra = {}) => compileRegistryEpoch({ declarations, source: SOURCE, ...extra });
const nextOf = (epoch, declarations) => nextRegistryEpoch(epoch, { declarations, source: SOURCE });

/* ---------------------------------------------------------------- contract */

test('the contract identifies itself, is versioned and declares its operations', () => {
  assert.equal(REGISTRY_COMPILER_CONTRACT, 'registry.compiler@0.1.0');
  assert.equal(REGISTRY_COMPILER_CONTRACT_VERSION, '0.1.0');
  assert.ok(Number.isInteger(REGISTRY_COMPILER_SCHEMA_VERSION) && REGISTRY_COMPILER_SCHEMA_VERSION >= 1);
  assert.deepEqual([...REGISTRY_COMPILER_OPERATIONS], ['compile', 'publish', 'rollback', 'diff']);
  assert.ok(REGISTRY_COMPILER_PERMISSIONS.every((word) => typeof word === 'string'));
  assert.deepEqual([...REGISTRY_EPOCH_ORIGINS], ['compile', 'rollback']);
  assert.equal(REGISTRY_EPOCH_GENESIS, 1);
  assert.ok(REGISTRY_EPOCH_SOURCE_MAX_LENGTH >= 64);
});

test('the refusal vocabulary is closed, prefixed and free of duplicates', () => {
  assert.ok(REGISTRY_COMPILER_REASONS.length >= 5);
  assert.equal(new Set(REGISTRY_COMPILER_REASONS).size, REGISTRY_COMPILER_REASONS.length);
  assert.ok(REGISTRY_COMPILER_REASONS.every((reason) => reason.startsWith('registry.')));
  // Authority is a documented rule, not an implementation detail.
  assert.match(REGISTRY_COMPILER_RULES.authority, /not admitting|no capability/);
  assert.match(REGISTRY_COMPILER_RULES.monotonic, /rollback/);
});

/* ------------------------------------------------------------ determinism */

test('compilation is deterministic across key order, declaration order and capability order', () => {
  const a = compile([declaration(), second()]);
  const b = compile([second(), declaration()]);
  const reordered = declaration({
    capabilities: ['network'],
    discovery: { description: 'Makes an HTTP request', group: 'input', displayName: 'HTTP Request' },
    resourceProfile: {
      startup: 'fast', concurrency: 'parallel-safe', network: true, disk: 'none', memory: 'medium', cpu: 'low',
    },
    compatibility: { portabilityTargets: ['JS'], contractRange: '^0.1.0' },
  });
  const c = compile([reordered, second()]);

  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.epochDigest, b.epochDigest, 'declaration order must not move the digest');
  assert.equal(a.epochDigest, c.epochDigest, 'key order must not move the digest');
  assert.equal(a.contentDigest, c.contentDigest);
  assert.deepEqual(a.identities, ['n8n-nodes-base.httpRequest@4.4', 'n8n-nodes-base.set@3.4']);
});

test('a single changed byte changes every digest', () => {
  const a = compile([declaration()]);
  const b = compile([declaration({ implementationVersion: '0.1.1' })]);
  assert.notEqual(a.contentDigest, b.contentDigest);
  assert.notEqual(a.epochDigest, b.epochDigest);
});

test('the epoch number, origin and source are part of the epoch digest', () => {
  const one = compile([declaration()], { epochNumber: 1 });
  const two = compile([declaration()], { epochNumber: 2 });
  assert.equal(one.contentDigest, two.contentDigest, 'same content, same content digest');
  assert.notEqual(one.epochDigest, two.epochDigest, 'different lineage, different epoch digest');
});

test('an empty source compiles to a valid, deterministic genesis epoch', () => {
  const a = compile([]);
  const b = compile([]);
  assert.ok(a.ok && a.count === 0 && a.identities.length === 0);
  assert.equal(a.epochDigest, b.epochDigest);
  assert.equal(a.epochNumber, REGISTRY_EPOCH_GENESIS);
});

/* --------------------------------------------------------- all-or-nothing */

test('one invalid declaration yields no epoch at all', () => {
  const result = compile([declaration(), declaration({ type: 'n8n-nodes-base.set', digest: 'sha256:nothex' })]);
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
  assert.equal(result.epochDigest, null);
  assert.equal(result.byIdentity, null);
  assert.deepEqual([...result.identities], []);
  assert.ok(result.errors.some((error) => error.code === 'registry.digest'));
  assert.equal(result.reason, 'registry.digest');
});

test('a duplicate identity compiles to nothing and keeps P6.1 wording', () => {
  const result = compile([declaration(), declaration()]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.duplicate');
  assert.match(result.errors[0].message, /duplicate identity is a conflict, not a precedence rule/);
});

test('a duplicate identity is a conflict even when the two entries differ', () => {
  const result = compile([declaration(), declaration({ implementationVersion: '9.9.9' })]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.duplicate');
  assert.equal(result.errors[0].position, 1);
});

test('unknown vocabulary still fails closed at compile time', () => {
  const unknownTrust = compile([declaration({ trustClass: 'probably-fine' })]);
  assert.equal(unknownTrust.ok, false);
  assert.equal(unknownTrust.reason, 'registry.trust');
  const unknownCapability = compile([declaration({ capabilities: ['teleport'] })]);
  assert.equal(unknownCapability.ok, false);
  assert.equal(unknownCapability.reason, 'registry.capability');
  const unknownField = compile([declaration({ trust: 'high' })]);
  assert.equal(unknownField.ok, false);
  assert.equal(unknownField.reason, 'registry.field');
});

/* ------------------------------------------------------------- epoch input */

test('an epoch must name its source, and the label is bounded', () => {
  const missing = compileRegistryEpoch({ declarations: [declaration()] });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'registry.epoch.source');
  const blank = compileRegistryEpoch({ declarations: [declaration()], source: '   ' });
  assert.equal(blank.reason, 'registry.epoch.source');
  const long = compileRegistryEpoch({ declarations: [declaration()], source: 'x'.repeat(REGISTRY_EPOCH_SOURCE_MAX_LENGTH + 1) });
  assert.equal(long.reason, 'registry.epoch.source');
  assert.match(long.errors[0].message, new RegExp(String(REGISTRY_EPOCH_SOURCE_MAX_LENGTH)));
});

test('a non-array declaration list and a bad epoch number are refused, not coerced', () => {
  assert.equal(compileRegistryEpoch({ declarations: declaration(), source: SOURCE }).reason, 'registry.epoch.invalid');
  for (const epochNumber of [0, -1, 1.5, '1', null]) {
    const result = compile([declaration()], { epochNumber });
    assert.equal(result.ok, false, `epochNumber ${JSON.stringify(epochNumber)} must be refused`);
    assert.equal(result.reason, 'registry.epoch.number');
  }
});

test('a parent that this contract did not freeze is refused', () => {
  const result = compile([declaration()], { epochNumber: 2, parent: { ok: true, epochNumber: 1, epochDigest: 'x', chain: [] } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.epoch.parent');
});

test('an epoch cannot be compiled onto a parent it does not advance beyond', () => {
  const parent = compile([declaration()]);
  const result = compile([declaration()], { epochNumber: parent.epochNumber, parent });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.epoch.monotonic');
  assert.match(result.errors[0].message, /only ever increase/);
});

test('a non-object input argument is refused instead of throwing a TypeError', () => {
  for (const input of [undefined, null, 'source', 42]) {
    const result = compileRegistryEpoch(input);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'registry.epoch.invalid');
  }
});

/* ---------------------------------------------------------------- lineage */

test('nextRegistryEpoch advances the number and records the parent digest', () => {
  const first = compile([declaration()]);
  const secondEpoch = nextOf(first, [declaration(), second()]);
  assert.ok(secondEpoch.ok);
  assert.equal(secondEpoch.epochNumber, first.epochNumber + 1);
  assert.equal(secondEpoch.parentEpochNumber, first.epochNumber);
  assert.equal(secondEpoch.parentEpochDigest, first.epochDigest);
  assert.equal(secondEpoch.origin, 'compile');
  assert.deepEqual(epochChainOf(secondEpoch), [first.epochDigest, secondEpoch.epochDigest]);
  assert.equal(secondEpoch.count, 2);
});

test('nextRegistryEpoch refuses a previous epoch that is not frozen', () => {
  assert.throws(() => nextRegistryEpoch({ epochNumber: 1 }, { declarations: [], source: SOURCE }), RegistryCompilerError);
});

test('the same content compiled onto two different parents is two different epochs', () => {
  const root = compile([declaration()]);
  const left = nextOf(root, [declaration(), second()]);
  const right = nextOf(root, [second()]);
  assert.notEqual(left.epochDigest, right.epochDigest);
  assert.equal(left.parentEpochDigest, right.parentEpochDigest, 'shared parent, diverging children');
});

/* --------------------------------------------------------------- rollback */

test('rollback reinstalls older content on a HIGHER epoch number and records its target', () => {
  const e1 = compile([declaration()]);
  const e2 = nextOf(e1, [declaration(), second()]);
  const e3 = nextOf(e2, [second()]);

  const rolledBack = rollbackRegistryEpoch(e3, e1);
  assert.ok(rolledBack.ok);
  assert.equal(rolledBack.epochNumber, e3.epochNumber + 1, 'the counter never rewinds');
  assert.equal(rolledBack.origin, 'rollback');
  assert.equal(rolledBack.contentDigest, e1.contentDigest, 'content is the target content, bit for bit');
  assert.notEqual(rolledBack.epochDigest, e1.epochDigest, 'but it is not the old epoch: it is a new one');

  const target = describeRegistryEpoch(rolledBack).rollbackTarget;
  assert.equal(target.epochNumber, e1.epochNumber);
  assert.equal(target.epochDigest, e1.epochDigest);
  assert.equal(rolledBack.source, `rollback:${e1.source}`);

  // The audit trail survives: a downgrade is visible as a downgrade.
  assert.deepEqual(epochChainOf(rolledBack), [e1.epochDigest, e2.epochDigest, e3.epochDigest, rolledBack.epochDigest]);
});

test('a rollback to a non-ancestor is refused — a chain is not a menu', () => {
  const root = compile([declaration()]);
  const left = nextOf(root, [declaration(), second()]);
  const right = nextOf(root, [second()]);

  const result = rollbackRegistryEpoch(left, right);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.epoch.unknown_target');
  assert.match(result.errors[0].message, /only an ancestor can be rolled back to/);
});

test('rolling back to the current epoch is refused as a no-op', () => {
  const e1 = compile([declaration()]);
  const e2 = nextOf(e1, [declaration(), second()]);
  const result = rollbackRegistryEpoch(e2, e2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.epoch.unknown_target');
});

test('a rolled-back epoch can be rolled forward again onto the same lineage', () => {
  const e1 = compile([declaration()]);
  const e2 = nextOf(e1, [declaration(), second()]);
  const back = rollbackRegistryEpoch(e2, e1);
  const forward = nextOf(back, [declaration(), second()]);
  assert.ok(forward.ok);
  assert.equal(forward.epochNumber, e2.epochNumber + 2);
  assert.equal(forward.contentDigest, e2.contentDigest, 'same content as the epoch it rolled back from');
  assert.equal(forward.chain.length, 4);
});

/* ------------------------------------------------------------ publication */

test('publication moves the pointer and reports what changed', () => {
  const e1 = compile([declaration()]);
  const e2 = nextOf(e1, [second()]);
  const result = publishRegistryEpoch(e1, e2);
  assert.equal(result.ok, true);
  assert.equal(result.published, e2);
  assert.equal(result.previous.epochNumber, e1.epochNumber);
  assert.deepEqual([...result.changed.added], ['n8n-nodes-base.set@3.4']);
  assert.deepEqual([...result.changed.removed], ['n8n-nodes-base.httpRequest@4.4']);
  assert.equal(result.changed.unchanged, 0);
});

test('publication never mutates the previous epoch', () => {
  const e1 = compile([declaration()]);
  const before = JSON.stringify(epochManifest(e1));
  const e2 = nextOf(e1, [declaration(), second()]);
  publishRegistryEpoch(e1, e2);
  assert.equal(JSON.stringify(epochManifest(e1)), before, 'the epoch in-flight work is reading must be untouchable');
  assert.equal(e1.count, 1, 'and its content must be unchanged');
});

test('publication refuses to rewind the epoch counter', () => {
  const e1 = compile([declaration()]);
  const e2 = nextOf(e1, [declaration(), second()]);
  assert.throws(() => publishRegistryEpoch(e2, e1), (error) => error.meta.code === 'registry.epoch.monotonic');
  assert.throws(() => publishRegistryEpoch(e1, e1), (error) => error.meta.code === 'registry.epoch.monotonic');
});

test('publication refuses an epoch compiled onto a different parent — no silent fork', () => {
  const root = compile([declaration()]);
  const left = nextOf(root, [declaration(), second()]);
  // A higher-numbered epoch, but compiled onto the root rather than onto `left`:
  // it is a fork, and publishing it over `left` would hide the other branch.
  const fork = compile([second()], { epochNumber: left.epochNumber + 1, parent: root });
  assert.equal(fork.parentEpochDigest, root.epochDigest);
  assert.throws(() => publishRegistryEpoch(left, fork), (error) => error.meta.code === 'registry.epoch.parent');
  // The same-numbered sibling is caught by the monotonic rule first, which is the
  // right refusal: it is not an epoch that advances the counter at all.
  assert.throws(() => publishRegistryEpoch(left, nextOf(root, [second()])), (error) => error.meta.code === 'registry.epoch.monotonic');
});

test('the compiler states which input schema version it consumes', () => {
  assert.ok(Number.isInteger(REGISTRY_COMPILER_INPUT_SCHEMA_VERSION));
  assert.equal(REGISTRY_COMPILER_INPUT_SCHEMA_VERSION, 1);
});

test('a failed publication leaves the current epoch published and usable', () => {
  const e1 = compile([declaration()]);
  const e2 = nextOf(e1, [declaration(), second()]);
  assert.throws(() => publishRegistryEpoch(e1, { ok: true, epochNumber: 99, epochDigest: 'forged', contract: REGISTRY_COMPILER_CONTRACT, schemaVersion: 1, byIdentity: {}, chain: [] }));
  assert.ok(isFrozenRegistryEpoch(e1));
  assert.equal(describeRegistryEpoch(e1).count, 1, 'nothing was half-applied');
  assert.equal(publishRegistryEpoch(e1, e2).published.epochNumber, 2);
});

/* --------------------------------------------------------------- integrity */

test('verifyRegistryEpoch accepts the content an epoch was compiled from', () => {
  const epoch = compile([declaration(), second()]);
  const result = verifyRegistryEpoch(epochManifest(epoch), [second(), declaration()]);
  assert.equal(result.ok, true);
  assert.equal(result.actual, epoch.contentDigest);
});

test('verifyRegistryEpoch detects tampering and says why', () => {
  const epoch = compile([declaration()]);
  const manifest = epochManifest(epoch);
  const tampered = [declaration({ implementationVersion: '0.0.1-evil' })];
  const result = verifyRegistryEpoch(manifest, tampered);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.epoch.digest');
  assert.notEqual(result.actual, result.expected);
});

test('verifyRegistryEpoch refuses a malformed manifest instead of guessing', () => {
  assert.equal(verifyRegistryEpoch(null, []).reason, 'registry.epoch.invalid');
  assert.equal(verifyRegistryEpoch({}, []).reason, 'registry.epoch.invalid');
});

test('verifyRegistryEpoch reports invalid content as invalid, not as a digest mismatch', () => {
  const epoch = compile([declaration()]);
  const result = verifyRegistryEpoch(epochManifest(epoch), [declaration({ digest: 'nope' })]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'registry.digest');
});

/* -------------------------------------------------------------------- diff */

test('diff sorts added, removed and changed deterministically and counts the rest', () => {
  const e1 = compile([declaration(), second()]);
  const e2 = nextOf(e1, [declaration({ implementationVersion: '0.2.0' }), declaration({ type: 'n8n-nodes-base.noOp', typeVersion: 1, discovery: { displayName: 'NoOp', group: 'transform', description: '' } })]);
  const diff = diffRegistryEpochs(e1, e2);
  assert.deepEqual([...diff.added], ['n8n-nodes-base.noOp@1']);
  assert.deepEqual([...diff.removed], ['n8n-nodes-base.set@3.4']);
  assert.deepEqual([...diff.changed], ['n8n-nodes-base.httpRequest@4.4']);
  assert.equal(diff.unchanged, 0);
  assert.equal(diff.fromEpoch, e1.epochNumber);
  assert.equal(diff.toEpoch, e2.epochNumber);
});

test('diff of an epoch against itself is empty', () => {
  const e1 = compile([declaration(), second()]);
  const diff = diffRegistryEpochs(e1, e1);
  assert.deepEqual([...diff.added, ...diff.removed, ...diff.changed], []);
  assert.equal(diff.unchanged, 2);
});

/* ------------------------------------------------------------ immutability */

test('a compiled epoch is deep-frozen, all the way down', () => {
  const epoch = compile([declaration()]);
  assert.ok(isFrozenRegistryEpoch(epoch));
  assert.ok(Object.isFrozen(epoch.identities));
  assert.ok(Object.isFrozen(epoch.byIdentity));
  assert.ok(Object.isFrozen(epoch.byIdentity['n8n-nodes-base.httpRequest@4.4']));
  assert.ok(Object.isFrozen(epoch.byIdentity['n8n-nodes-base.httpRequest@4.4'].declaration));
  assert.ok(Object.isFrozen(epoch.byIdentity['n8n-nodes-base.httpRequest@4.4'].declaration.resourceProfile));
  assert.throws(() => { 'use strict'; epoch.count = 99; }, TypeError);
  assert.throws(() => { 'use strict'; epoch.byIdentity['n8n-nodes-base.httpRequest@4.4'].declaration.trustClass = 'trusted'; }, TypeError);
  assert.equal(epoch.count, 1);
  assert.equal(epoch.byIdentity['n8n-nodes-base.httpRequest@4.4'].declaration.trustClass, 'core');
});

test('freezeRegistryEpoch is idempotent and refuses non-objects', () => {
  const epoch = compile([declaration()]);
  assert.equal(freezeRegistryEpoch(epoch), epoch);
  assert.equal(freezeRegistryEpoch(freezeRegistryEpoch(epoch)), epoch);
  assert.throws(() => freezeRegistryEpoch('epoch'), RegistryCompilerError);
});

test('isFrozenRegistryEpoch rejects a plain copy of an epoch — freezing is not decoration', () => {
  const epoch = compile([declaration()]);
  const copy = JSON.parse(JSON.stringify(epochManifest(epoch)));
  assert.equal(isFrozenRegistryEpoch(copy), false);
  assert.equal(isFrozenRegistryEpoch({ ...epoch }), false, 'a shallow copy is not a frozen epoch');
  assert.equal(isFrozenRegistryEpoch(epoch), true);
});

/* ------------------------------------------------------------------ reads */

test('epochManifest is serializable, stable and free of live references', () => {
  const epoch = compile([declaration(), second()]);
  const manifest = epochManifest(epoch);
  assert.equal(manifest.count, 2);
  assert.equal(manifest.contract, REGISTRY_COMPILER_CONTRACT);
  assert.equal(manifest.epochDigest, epoch.epochDigest);
  assert.equal(manifest.digests['n8n-nodes-base.set@3.4'], epoch.byIdentity['n8n-nodes-base.set@3.4'].digest);
  const roundTripped = JSON.parse(JSON.stringify(manifest));
  assert.deepEqual(roundTripped.identities, [...epoch.identities], 'identities stay sorted across a round trip');
  assert.ok(Object.isFrozen(manifest));
});

test('describeRegistryEpoch answers "which registry is live" without a clock or a store', () => {
  const e1 = compile([declaration()]);
  const e2 = nextOf(e1, [declaration(), second()]);
  const described = describeRegistryEpoch(e2);
  assert.equal(described.epochNumber, 2);
  assert.equal(described.count, 2);
  assert.equal(described.origin, 'compile');
  assert.equal(described.parentEpochNumber, 1);
  assert.equal(described.chainLength, 2);
  assert.equal(described.frozen, true);
  assert.equal(described.rollbackTarget, null);
  assert.deepEqual(described.identities, ['n8n-nodes-base.httpRequest@4.4', 'n8n-nodes-base.set@3.4']);
  assert.match(formatRegistryEpoch(e2), /^epoch 2 \(compile, catalog:n8n-nodes-base@2\.9\.1\) 2 nodes [0-9a-f]{12}$/);
});

test('epochEntryOf returns the canonical entry, or null for an unknown identity', () => {
  const epoch = compile([declaration()]);
  const entry = epochEntryOf(epoch, 'n8n-nodes-base.httpRequest@4.4');
  assert.equal(entry.digest, epoch.byIdentity['n8n-nodes-base.httpRequest@4.4'].digest);
  assert.equal(entry.canonical.trustClass, 'core');
  assert.ok(Object.isFrozen(entry));
  assert.equal(epochEntryOf(epoch, 'n8n-nodes-base.nope@1'), null);
});

test('epochIdentityOf quotes P6.1 rather than re-deriving identity', () => {
  assert.equal(epochIdentityOf(declaration()), 'n8n-nodes-base.httpRequest@4.4');
  assert.equal(epochIdentityOf({ type: 'n8n-nodes-base.set', typeVersion: 3 }), 'n8n-nodes-base.set@3');
});

test('a forged epoch is refused by every read that requires a frozen epoch', () => {
  const forged = { ok: true, epochNumber: 2, epochDigest: 'f'.repeat(64), byIdentity: {}, chain: [] };
  assert.throws(() => epochManifest(forged), RegistryCompilerError);
  assert.throws(() => describeRegistryEpoch(forged), RegistryCompilerError);
  assert.throws(() => epochChainOf(forged), RegistryCompilerError);
  assert.throws(() => diffRegistryEpochs(compile([]), forged), RegistryCompilerError);
});

/* ------------------------------------------------------------ scope walls */

test('P6.2 publishes exactly one contract row and its surface is one file', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'registry.compiler');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, REGISTRY_COMPILER_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.deepEqual(rows[0].surface, ['src/lego/registry-compiler.mjs']);
  assert.deepEqual(rows[0].exports['src/lego/registry-compiler.mjs'].sort(), Object.keys({
    REGISTRY_COMPILER_CONTRACT, REGISTRY_COMPILER_CONTRACT_VERSION, REGISTRY_COMPILER_SCHEMA_VERSION,
    REGISTRY_COMPILER_OPERATIONS, REGISTRY_COMPILER_PERMISSIONS, REGISTRY_COMPILER_REASONS, REGISTRY_COMPILER_RULES,
    REGISTRY_EPOCH_GENESIS, REGISTRY_EPOCH_ORIGINS, REGISTRY_EPOCH_SOURCE_MAX_LENGTH, RegistryCompilerError,
    compileRegistryEpoch, describeRegistryEpoch, diffRegistryEpochs, epochChainOf, epochEntryOf, epochIdentityOf,
    epochManifest, formatRegistryEpoch, freezeRegistryEpoch, isFrozenRegistryEpoch, nextRegistryEpoch,
    publishRegistryEpoch, rollbackRegistryEpoch, verifyRegistryEpoch, REGISTRY_COMPILER_INPUT_SCHEMA_VERSION,
  }).sort());
  // The domain keeps its own primary contract: P6.2 adds a row, it does not take over the domain.
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/registry-compiler.mjs'));
});

test('the compiler is pure: no clock, no filesystem, no process, no network', () => {
  const source = readFileSync(new URL('../src/lego/registry-compiler.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['Date', 'process.', 'node:fs', 'node:net', 'node:http', 'Math.random', 'performance.', 'setTimeout', 'node:os', 'node:child_process']) {
    assert.equal(code.includes(forbidden), false, `registry compiler must not reference ${forbidden}`);
  }
  assert.equal(code.includes("from './node-registry.mjs'"), true);
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
});

test('an epoch carries no wall-clock field: reproducibility is the contract', () => {
  const epoch = compile([declaration()]);
  for (const field of ['compiledAt', 'timestamp', 'createdAt', 'updatedAt', 'now']) {
    assert.equal(Object.hasOwn(epoch, field), false, `epoch must not carry ${field}`);
  }
  const secondRun = compile([declaration()]);
  assert.equal(epoch.epochDigest, secondRun.epochDigest, 'two compiles at different times agree');
});

test('P6.2 scope walls: no install journal, artifact store, lease or health vocabulary', () => {
  const names = Object.keys({
    REGISTRY_COMPILER_CONTRACT, REGISTRY_COMPILER_CONTRACT_VERSION, REGISTRY_COMPILER_SCHEMA_VERSION,
    REGISTRY_COMPILER_OPERATIONS, REGISTRY_COMPILER_PERMISSIONS, REGISTRY_COMPILER_REASONS, REGISTRY_COMPILER_RULES,
    REGISTRY_EPOCH_GENESIS, REGISTRY_EPOCH_ORIGINS, REGISTRY_EPOCH_SOURCE_MAX_LENGTH, RegistryCompilerError,
    compileRegistryEpoch, describeRegistryEpoch, diffRegistryEpochs, epochChainOf, epochEntryOf, epochIdentityOf,
    epochManifest, formatRegistryEpoch, freezeRegistryEpoch, isFrozenRegistryEpoch, nextRegistryEpoch,
    publishRegistryEpoch, rollbackRegistryEpoch, verifyRegistryEpoch, REGISTRY_COMPILER_INPUT_SCHEMA_VERSION,
  }).join(' ');
  for (const later of ['install', 'journal', 'artifact', 'lease', 'quarantine', 'attest', 'sbom', 'canary', 'residency']) {
    assert.equal(new RegExp(later, 'i').test(names), false, `${later} belongs to a later milestone`);
  }
});
