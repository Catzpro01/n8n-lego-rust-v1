/**
 * P2.7 — LEGO lifecycle certification tests.
 *
 * P2.6 proved the boundaries exist. P2.7 has to prove the architecture survives
 * *change*: that a sub-LEGO can be upgraded alone, an implementation can be
 * swapped, compatibility can be decided, and none of it is faked with a JSON
 * comparison. Every proof below drives the real registry, the real contracts
 * and the real gate.
 *
 *   §1 nested LEGO           parent -> child -> grandchild, registry-level
 *   §2 nested boundaries     public/private and dependency rules at every depth
 *   §3 sub-LEGO upgrade      B v1 -> v2 without touching A or C or the parent
 *   §4 implementation swap   one contract, two implementations, blind consumer
 *   §5 compatibility model   compatible / breaking / migration-required
 *   §6 upgrade lifecycle     check -> migrate -> test -> activate
 *   §7 scale-out readiness   no hidden process-local coupling in new LEGO code
 *   §8 gate certification    nested + version violations are mechanically caught
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MAX_NESTING_DEPTH,
  getAncestors,
  getChildren,
  getDescendants,
  getDomain,
  isDependencyAllowed,
  isPublicPath,
  isWithin,
  lineage,
  loadRegistry,
  nestingDepth,
  rootOf,
  tree,
  validateRegistry,
} from '../src/lego/registry.mjs';
import {
  CHANGE_KINDS,
  canReplaceImplementation,
  classifyChange,
  compareVersions,
  parseVersion,
  planUpgrade,
  satisfies,
} from '../src/lego/compat.mjs';
import {
  REFERENCE_CONTRACT_VERSION,
  REFERENCE_SUBLEGOS,
  createReferenceTree,
} from '../src/reference-lego/contract/index.mjs';
import {
  VALIDATION_CONTRACT_VERSION,
  VALIDATION_OPERATIONS,
  createValidationLego,
} from '../src/reference-lego/sub/validation/contract/index.mjs';
import {
  SCHEMA_CONTRACT_VERSION,
  SCHEMA_IMPLEMENTATIONS,
  SCHEMA_OPERATIONS,
  createSchemaChecker,
} from '../src/reference-lego/sub/validation/sub/schema/contract/index.mjs';
import {
  REPOSITORY_CONTRACT_VERSION,
  createRepositoryLego,
} from '../src/reference-lego/sub/repository/contract/index.mjs';
import { runGate } from '../../../tools/lego/architecture-gate.core.mjs';
import { runRegistrySelftest, runSelftest } from '../../../tools/lego/architecture-gate.selftest.mjs';
import { scanScaleOut } from '../../../tools/lego/scale-out-readiness.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadRegistry({ reload: true });

/* ------------------------------------------------------------ §1 nested LEGO */

test('the registry supports parent -> child -> grandchild', () => {
  const parent = getDomain('reference-lego', registry);
  const child = getDomain('reference-lego.validation', registry);
  const grandchild = getDomain('reference-lego.validation.schema', registry);

  assert.equal(child.parent, parent.id);
  assert.equal(grandchild.parent, child.id);
  assert.equal(nestingDepth(parent.id, registry), 1);
  assert.equal(nestingDepth(child.id, registry), 2);
  assert.equal(nestingDepth(grandchild.id, registry), 3);
  assert.deepEqual(lineage(grandchild.id, registry), [parent.id, child.id, grandchild.id]);
  assert.equal(rootOf(grandchild.id, registry).id, parent.id);
  assert.deepEqual(
    getChildren(parent.id, registry).map((domain) => domain.id),
    ['reference-lego.validation', 'reference-lego.repository'],
  );
  assert.equal(getDescendants(parent.id, registry).length, 3);
  assert.deepEqual(
    getAncestors(grandchild.id, registry).map((domain) => domain.id),
    [child.id, parent.id],
  );
});

test('every sub-LEGO declares the full LEGO metadata set', () => {
  for (const id of ['reference-lego.validation', 'reference-lego.validation.schema', 'reference-lego.repository']) {
    const domain = getDomain(id, registry);
    assert.ok(domain.owner, `${id}: owner`);
    assert.ok(domain.contract?.version, `${id}: contract version`);
    assert.ok(domain.contract?.tests?.length, `${id}: test boundary`);
    assert.ok(domain.capabilities?.length, `${id}: capability`);
    assert.ok(Array.isArray(domain.dependsOn), `${id}: dependencies`);
    assert.ok(domain.public?.length, `${id}: public surface`);
    assert.ok(domain.errorNamespace, `${id}: error namespace`);
    assert.ok(domain.status, `${id}: implementation status`);
  }
});

test('nesting is bounded and the hierarchy is a forest', () => {
  assert.equal(MAX_NESTING_DEPTH, 3);
  for (const domain of registry.domains) {
    assert.ok(nestingDepth(domain.id, registry) <= MAX_NESTING_DEPTH, `${domain.id} nests too deep`);
  }
  const roots = tree(registry);
  assert.ok(roots.length > 0);
  assert.equal(roots.filter((node) => node.id === 'reference-lego')[0].children.length, 2);
  assert.deepEqual(validateRegistry(registry), []);
});

test('ownership stays single-writer at sub-LEGO level', () => {
  const claims = new Map();
  for (const [agentId, agent] of Object.entries(registry.agents)) {
    for (const domainId of agent.domains) {
      assert.equal(claims.get(domainId), undefined, `'${domainId}' claimed twice`);
      claims.set(domainId, agentId);
    }
  }
  for (const id of ['reference-lego.validation', 'reference-lego.validation.schema', 'reference-lego.repository']) {
    assert.equal(claims.get(id), getDomain(id, registry).owner);
  }
});

/* ------------------------------------------------------ §2 nested boundaries */

test('the public/private rule applies at every depth', () => {
  const child = getDomain('reference-lego.validation', registry);
  const grandchild = getDomain('reference-lego.validation.schema', registry);

  assert.equal(isPublicPath('src/reference-lego/sub/validation/contract/index.mjs', child), true);
  assert.equal(isPublicPath('src/reference-lego/sub/validation/internal/rules.mjs', child), false);
  assert.equal(
    isPublicPath('src/reference-lego/sub/validation/sub/schema/contract/index.mjs', grandchild),
    true,
  );
  assert.equal(
    isPublicPath('src/reference-lego/sub/validation/sub/schema/internal/table-checker.mjs', grandchild),
    false,
  );
});

test('a parent may compose its children, but siblings may not reach each other', () => {
  // Composition inside one LEGO needs no dependsOn entry…
  assert.equal(isDependencyAllowed('reference-lego', 'reference-lego.validation', registry).allowed, true);
  assert.equal(isDependencyAllowed('reference-lego.validation', 'reference-lego', registry).allowed, true);
  assert.equal(
    isDependencyAllowed('reference-lego', 'reference-lego.validation.schema', registry).rule,
    'parent-child',
  );
  // …but siblings are separate LEGOs.
  const siblings = isDependencyAllowed('reference-lego.validation', 'reference-lego.repository', registry);
  assert.equal(siblings.allowed, false);
  assert.equal(siblings.rule, 'forbidden-direction');
});

test('a sub-LEGO cannot escape its parent prohibition, and parent access is not child access', () => {
  // The parent forbids `storage`; the grandchild must not be able to route around it.
  const escaped = isDependencyAllowed('reference-lego.validation.schema', 'storage', registry);
  assert.equal(escaped.allowed, false);
  assert.match(escaped.reason, /ancestor|must not depend/);

  // Depending on a parent does not grant its children.
  assert.equal(isWithin('reference-lego.validation.schema', 'reference-lego', registry), true);
  assert.equal(isWithin('reference-lego', 'reference-lego.validation', registry), false);
});

/* ------------------------------------------------- §3 sub-LEGO upgrade proof */

test('a sub-LEGO upgraded alone leaves its siblings and parent untouched', () => {
  // The state the fixtures record: B moved 1.0.0 -> 1.1.0.
  const validation = getDomain('reference-lego.validation', registry);
  assert.equal(validation.contract.previousVersion, '1.0.0');
  assert.equal(validation.contract.version, '1.1.0');
  assert.equal(VALIDATION_CONTRACT_VERSION, '1.1.0');

  // A and C did not move…
  assert.equal(getDomain('reference-lego.repository', registry).contract.version, '1.0.0');
  assert.equal(REPOSITORY_CONTRACT_VERSION, '1.0.0');
  assert.equal(getDomain('reference-lego.validation.schema', registry).contract.version, '1.0.0');
  assert.equal(SCHEMA_CONTRACT_VERSION, '1.0.0');

  // …and neither did the parent's own contract.
  assert.equal(REFERENCE_CONTRACT_VERSION, '1.0.0');

  // The upgrade is compatible, so the parent's declared requirement still holds.
  const required = getDomain('reference-lego', registry).requires['reference-lego.validation'];
  assert.equal(required, '^1.0.0');
  assert.equal(satisfies('1.1.0', required).satisfied, true, 'the parent must not be forced to change');
  assert.equal(classifyChange('1.0.0', '1.1.0').kind, 'compatible');
});

test('the upgraded sub-LEGO is backward compatible in behaviour, not just in version', () => {
  const lego = createValidationLego();
  // A 1.0.0-era consumer calls validate(value) with no options and must see
  // exactly the old behaviour — `strict` defaults off.
  assert.deepEqual(lego.validate({ name: 'ok' }), { valid: true, issues: [] });
  assert.equal(lego.validate({ name: '' }).valid, false);
  // The 1.1.0 additions exist alongside, never in place of.
  assert.deepEqual(VALIDATION_OPERATIONS, ['validate', 'explain']);
  assert.equal(typeof lego.explain, 'function');
  assert.ok(lego.explain({ name: 'ok' }).some((line) => line.startsWith('description:')));
});

test('an incompatible sub-LEGO upgrade is refused by the compatibility model', () => {
  const plan = planUpgrade({
    id: 'reference.validation',
    from: '1.1.0',
    to: '2.0.0',
    consumers: [{ id: 'reference-lego', requires: '^1.0.0' }],
  });
  assert.equal(plan.change, 'breaking');
  assert.equal(plan.safeToActivate, false);
  assert.deepEqual(plan.blockedBy, ['reference-lego']);
  assert.equal(plan.requiresSignOff, true);
  assert.equal(plan.steps.find((step) => step.step === 'activation').status, 'blocked');
});

/* ------------------------------------------- §4 implementation replacement */

test('one contract, two implementations, and the consumer cannot tell', () => {
  assert.deepEqual(Object.keys(SCHEMA_IMPLEMENTATIONS).sort(), ['strict', 'table']);

  const a = createSchemaChecker({ implementation: 'strict' });
  const b = createSchemaChecker({ implementation: 'table' });

  // Same contract identity and version behind both.
  assert.equal(a.capability, b.capability);
  assert.equal(a.version, b.version);

  // Behaviour is indistinguishable across the contract surface.
  for (const value of [{ name: 'x' }, { name: 'x', version: 2 }, { name: 1 }, { version: 'no' }, {}, null, [], 'str']) {
    assert.deepEqual(a.check(value), b.check(value), `implementations diverge for ${JSON.stringify(value)}`);
  }
});

test('the consumer keeps working when the implementation is swapped underneath it', () => {
  const withA = createValidationLego({ schema: createSchemaChecker({ implementation: 'strict' }) });
  const withB = createValidationLego({ schema: createSchemaChecker({ implementation: 'table' }) });

  for (const value of [{ name: 'ok' }, { name: '' }, { name: 3 }, {}]) {
    assert.deepEqual(withA.validate(value), withB.validate(value), 'the consumer observed the swap');
  }
  // And the consumer's own contract identity is unchanged either way.
  assert.equal(withA.version, withB.version);
});

test('replacement safety is decidable, not a matter of opinion', () => {
  const contract = { id: 'reference.validation.schema', version: '1.0.0', operations: SCHEMA_OPERATIONS };

  const good = canReplaceImplementation({
    contract,
    current: { contract: 'reference.validation.schema', version: '1.0.0', port: createSchemaChecker() },
    replacement: {
      contract: 'reference.validation.schema',
      version: '1.0.0',
      port: createSchemaChecker({ implementation: 'table' }),
    },
  });
  assert.equal(good.safe, true, JSON.stringify(good.problems));

  // A replacement missing an operation is refused.
  const missing = canReplaceImplementation({
    contract,
    current: { contract: 'reference.validation.schema', version: '1.0.0', port: createSchemaChecker() },
    replacement: { contract: 'reference.validation.schema', version: '1.0.0', port: {} },
  });
  assert.equal(missing.safe, false);
  assert.match(missing.problems.join(' '), /does not implement check/);

  // A replacement of a different contract is refused.
  const wrong = canReplaceImplementation({
    contract,
    current: { contract: 'reference.validation.schema', version: '1.0.0', port: createSchemaChecker() },
    replacement: { contract: 'reference.repository', version: '1.0.0', port: createRepositoryLego() },
  });
  assert.equal(wrong.safe, false);
  assert.match(wrong.problems.join(' '), /different contract id/);
});

test('the whole nested tree still works through the parent contract', () => {
  const tree1 = createReferenceTree();
  assert.deepEqual(tree1.composition, REFERENCE_SUBLEGOS);
  assert.deepEqual(tree1.store({ id: 'a', name: 'fine' }), { stored: true, issues: [] });
  assert.equal(tree1.read('a').name, 'fine');
  assert.equal(tree1.store({ id: 'b', name: '' }).stored, false);

  // Injecting a different child implementation changes nothing the parent promises.
  const tree2 = createReferenceTree({
    validation: createValidationLego({ schema: createSchemaChecker({ implementation: 'table' }) }),
  });
  assert.deepEqual(tree2.store({ id: 'a', name: 'fine' }), { stored: true, issues: [] });
  assert.equal(tree2.version, tree1.version);
});

/* ------------------------------------------------- §5 compatibility model */

test('version comparison and range satisfaction behave', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.throws(() => parseVersion('1.2'), /invalid contract version/);
  assert.equal(compareVersions('1.2.3', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);

  assert.equal(satisfies('1.5.0', '^1.2.0').satisfied, true);
  assert.equal(satisfies('2.0.0', '^1.2.0').satisfied, false);
  assert.equal(satisfies('1.1.0', '^1.2.0').satisfied, false, 'older than the floor');
  assert.equal(satisfies('1.2.9', '~1.2.0').satisfied, true);
  assert.equal(satisfies('1.3.0', '~1.2.0').satisfied, false);
  assert.equal(satisfies('9.9.9', '*').satisfied, true);
  assert.equal(satisfies('1.0.0', '1.0.0').satisfied, true);
  assert.equal(satisfies('1.0.1', '1.0.0').satisfied, false, 'exact pins are exact');
  assert.equal(satisfies('1.2.0', '>=1.0.0').satisfied, true);
});

test('0.x contracts are treated as provisional, because P2.6 said they are', () => {
  // A 0.x minor may break, so ^0.2.1 must not silently accept 0.3.0.
  assert.equal(satisfies('0.2.5', '^0.2.1').satisfied, true);
  assert.equal(satisfies('0.3.0', '^0.2.1').satisfied, false);
  assert.equal(classifyChange('0.1.0', '0.2.0').kind, 'breaking');
  assert.equal(classifyChange('0.1.0', '0.1.1').kind, 'compatible');
});

test('the three upgrade kinds are distinguished', () => {
  assert.ok(CHANGE_KINDS.includes('migration-required'));
  assert.equal(classifyChange('1.0.0', '1.0.0').kind, 'unchanged');
  assert.equal(classifyChange('1.0.0', '1.0.1').kind, 'compatible');
  assert.equal(classifyChange('1.0.0', '1.1.0').kind, 'compatible');
  assert.equal(classifyChange('1.0.0', '2.0.0').kind, 'breaking');
  assert.equal(classifyChange('2.0.0', '1.0.0').kind, 'downgrade');
  // Migration points are declared, never guessed.
  assert.equal(classifyChange('1.0.0', '1.2.0', { migrations: ['1.1.0'] }).kind, 'migration-required');
  assert.equal(classifyChange('1.2.0', '1.3.0', { migrations: ['1.1.0'] }).kind, 'compatible');
});

/* ------------------------------------------------- §6 the upgrade lifecycle */

test('the minimum lifecycle is expressed as an executable plan', () => {
  const plan = planUpgrade({
    id: 'reference.validation',
    from: '1.0.0',
    to: '1.1.0',
    consumers: [{ id: 'reference-lego', requires: '^1.0.0' }],
  });
  assert.deepEqual(
    plan.steps.map((step) => step.step),
    ['compatibility-check', 'migration', 'tests', 'activation'],
  );
  assert.equal(plan.steps[0].status, 'pass');
  assert.equal(plan.steps[1].status, 'not-required');
  assert.equal(plan.steps[2].status, 'required', 'tests are never optional');
  assert.equal(plan.steps[3].status, 'allowed');
  assert.equal(plan.safeToActivate, true);
  assert.equal(plan.requiresMigration, false);
});

test('a migration-required upgrade says so before activation', () => {
  const plan = planUpgrade({
    id: 'example.contract',
    from: '1.0.0',
    to: '1.2.0',
    migrations: ['1.1.0'],
    consumers: [{ id: 'consumer-a', requires: '^1.0.0' }],
  });
  assert.equal(plan.change, 'migration-required');
  assert.equal(plan.requiresMigration, true);
  assert.equal(plan.steps.find((step) => step.step === 'migration').status, 'required');
  // Still activatable once migrated: the consumers are compatible.
  assert.equal(plan.safeToActivate, true);
});

test('the parent/sub-LEGO lifecycle rule is written down where it is enforced', () => {
  const policy = registry.contractLock.policy;
  assert.ok(policy.parentChildRule, 'the lock must state the parent/child bump rule');
  assert.match(policy.parentChildRule, /does NOT version-bump/i);
  assert.ok(policy.compatibilityModel?.kinds?.includes('migration-required'));
});

/* --------------------------------------------------- §7 scale-out readiness */

test('no new LEGO code introduces hidden process-local coupling', () => {
  const result = scanScaleOut(registry);
  const newLegoFailures = result.findings.filter((finding) => finding.status === 'fail-new-lego');
  assert.deepEqual(
    newLegoFailures.map((finding) => `${finding.probe} ${finding.file}`),
    [],
    'contract-first LEGO code must be process-agnostic',
  );
});

test('every scale-out finding in existing code is declared, owned and dated', () => {
  const result = scanScaleOut(registry);
  assert.deepEqual(
    result.failures.map((failure) => `${failure.probe ?? '?'} ${failure.file}: ${failure.status}`),
    [],
  );
  assert.ok(result.declared >= 8, 'the honest state of the tree includes real exceptions');
  for (const exception of registry.manifest.scaleOut.exceptions) {
    assert.ok(exception.owner, `${exception.file}: owner`);
    assert.ok(exception.reason, `${exception.file}: reason`);
    assert.ok(exception.resolution, `${exception.file}: resolution plan`);
    assert.ok(['blocking', 'should-fix', 'benign', 'accepted'].includes(exception.severity), `${exception.file}: severity`);
    assert.ok(existsSync(join(APP_ROOT, exception.file)), `${exception.file} must exist`);
  }
});

test('the blockers to running a second process are named, not glossed over', () => {
  const blocking = registry.manifest.scaleOut.exceptions.filter((exception) => exception.severity === 'blocking');
  assert.ok(blocking.length > 0, 'P2.7 must not claim the backend is already scale-out ready');
  assert.ok(
    blocking.every((exception) => exception.domain === 'storage'),
    'the blockers are storage-owned: id allocation and local-disk state',
  );
  assert.ok(registry.manifest.scaleOut.blockingForScaleOut.length >= 2);
});

test('the scale-out rule set forbids cross-LEGO persistence access', () => {
  const rules = registry.manifest.scaleOut.rules.join(' ');
  assert.match(rules, /must not reach another LEGO's database|persistence internals/i);
  // And that rule is actually enforced by the dependency gate, not just stated.
  assert.equal(isDependencyAllowed('node-registry', 'storage', registry).allowed, false);
  assert.equal(isDependencyAllowed('workflow', 'legacy-rest', registry).allowed, false);
});

/* -------------------------------------------------- §8 gate certification */

test('the architecture gate is green on the nested tree', () => {
  assert.deepEqual(
    runGate({ registry }).map((violation) => `${violation.rule} ${violation.file}: ${violation.message}`),
    [],
  );
});

test('the gate detects nested-LEGO violations', () => {
  const results = runSelftest();
  const nested = results.filter((result) => result.name.startsWith('nested:'));
  assert.ok(nested.length >= 4, 'nested fixtures must exist');
  for (const result of nested) {
    assert.ok(result.detected, `undetected: ${result.name} (saw ${result.saw.join(', ') || 'nothing'})`);
  }
});

test('the gate detects version and hierarchy violations in the registry itself', () => {
  const results = runRegistrySelftest();
  assert.ok(results.length >= 7);
  for (const result of results) {
    assert.ok(result.detected, `undetected: ${result.name} (saw ${result.saw.join(', ') || 'nothing'})`);
  }
  const names = results.map((result) => result.name).join(' | ');
  assert.match(names, /consumer requirement the provider no longer satisfies/);
  assert.match(names, /breaking bump with no changelog/);
  assert.match(names, /sub-LEGO owns a path outside its parent/);
});

test('still no Rust, and the reference tree is still not mounted', () => {
  assert.equal(existsSync(join(APP_ROOT, 'src', 'reference-lego', 'Cargo.toml')), false);
  for (const id of ['reference-lego', 'reference-lego.validation', 'reference-lego.validation.schema', 'reference-lego.repository']) {
    assert.equal(getDomain(id, registry).kind, 'template', `${id} must stay a template`);
  }
});
