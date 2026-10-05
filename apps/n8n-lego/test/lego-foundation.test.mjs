/**
 * P2.6 — Backend LEGO foundation contract tests.
 *
 * These tests do not exercise any feature. They assert that the *architecture*
 * holds:
 *
 *   §1 the domain registry is structurally valid and unambiguous,
 *   §2 ownership is single-writer (no domain claimed by two agents),
 *   §3 dependency direction is declared and acyclic,
 *   §4 the error contract is machine-readable and namespaced,
 *   §5 contract versioning is locked to the real exported surface,
 *   §6 the reference LEGO demonstrates the contract/internal split,
 *   §7 the architecture gate is green on this tree AND provably catches
 *      forbidden dependencies (a gate that never fails proves nothing).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DOMAIN_KINDS,
  DOMAIN_STATUS,
  domainForPath,
  getCapability,
  getDomain,
  isDependencyAllowed,
  isPublicPath,
  listCapabilities,
  loadRegistry,
  validateRegistry,
} from '../src/lego/registry.mjs';
import {
  ERROR_CODES,
  ERROR_CONTRACT_VERSION,
  assertErrorCode,
  codesForNamespace,
  errorCode,
  isErrorCode,
  statusForCode,
} from '../src/lego/errors.mjs';
import { createReferenceLego, REFERENCE_CAPABILITY, ReferenceError } from '../src/reference-lego/contract/index.mjs';
import { runGate } from '../../../tools/lego/architecture-gate.core.mjs';
import { runNegativeControl, runSelftest, CASES } from '../../../tools/lego/architecture-gate.selftest.mjs';
import { checkCapabilityConformance } from '../../../tools/lego/capability-conformance.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadRegistry({ reload: true });

/* ---------------------------------------------------------------- §1 registry */

test('the domain registry is structurally valid', () => {
  assert.deepEqual(validateRegistry(registry), []);
});

test('the registry describes every domain P2.6 requires a boundary for', () => {
  const required = [
    'auth',
    'credentials',
    'workflow',
    'execution',
    'node-registry',
    'dynamic-parameters',
    'webhook',
    'storage',
    'worker',
    'compatibility',
  ];
  for (const id of required) {
    const domain = getDomain(id, registry);
    assert.ok(domain, `domain '${id}' must be registered`);
    assert.ok(DOMAIN_KINDS.includes(domain.kind), `${id}: kind`);
    assert.ok(DOMAIN_STATUS.includes(domain.status), `${id}: status`);
    assert.ok(domain.owner, `${id}: owner`);
    assert.ok(domain.errorNamespace, `${id}: errorNamespace`);
    assert.ok(domain.contract?.version, `${id}: contract version`);
  }
});

test('every domain declares ownership metadata, and no path has two owners', () => {
  const seen = new Map();
  for (const domain of registry.domains) {
    assert.ok(registry.agents[domain.owner], `${domain.id} has an unknown owner`);
    for (const path of domain.paths ?? []) {
      assert.equal(seen.get(path), undefined, `path '${path}' claimed twice`);
      seen.set(path, domain.id);
    }
  }
});

test('a file resolves to exactly one owning domain, longest path wins', () => {
  assert.equal(domainForPath('src/compat/error.mjs', registry).id, 'compatibility');
  assert.equal(domainForPath('src/auth.mjs', registry).id, 'auth');
  assert.equal(domainForPath('src/auth/routes.mjs', registry).id, 'auth');
  assert.equal(domainForPath('src/rest/routes.mjs', registry).id, 'legacy-rest');
  assert.equal(domainForPath('src/server.mjs', registry).id, 'runtime-host');
  assert.equal(domainForPath('src/nowhere.mjs', registry), null);
});

/* --------------------------------------------------------------- §2 ownership */

test('no domain is silently owned by two agents', () => {
  const claims = new Map();
  for (const [agentId, agent] of Object.entries(registry.agents)) {
    for (const domainId of agent.domains) {
      assert.equal(claims.get(domainId), undefined, `'${domainId}' claimed by ${claims.get(domainId)} and ${agentId}`);
      claims.set(domainId, agentId);
    }
  }
  for (const domain of registry.domains) {
    assert.equal(claims.get(domain.id), domain.owner, `ownership mismatch for '${domain.id}'`);
  }
});

test('every agent role in the P2.6 ownership model is represented', () => {
  for (const agent of ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6', 'manager']) {
    assert.ok(registry.agents[agent]?.role, `${agent} must have a declared role`);
    assert.ok(registry.agents[agent].domains.length > 0, `${agent} must own at least one domain`);
  }
});

/* -------------------------------------------------------------- §3 dependency */

test('the declared dependency direction is enforced, both ways', () => {
  // Allowed: workflow consumes execution.
  assert.equal(isDependencyAllowed('workflow', 'execution', registry).allowed, true);
  // Forbidden: execution must not reach back into workflow.
  const back = isDependencyAllowed('execution', 'workflow', registry);
  assert.equal(back.allowed, false);
  assert.equal(back.rule, 'forbidden-direction');
  // Forbidden: storage internals must not depend on a consumer.
  assert.equal(isDependencyAllowed('storage', 'workflow', registry).allowed, false);
  // Forbidden: node internals must not reach credential persistence.
  assert.equal(isDependencyAllowed('node-registry', 'credentials', registry).allowed, false);
  // Undeclared is not the same as forbidden, and is still rejected.
  const undeclared = isDependencyAllowed('realtime', 'settings', registry);
  assert.equal(undeclared.allowed, false);
  assert.equal(undeclared.rule, 'undeclared-dependency');
});

test('the shared kernel is a graph leaf', () => {
  const kernel = getDomain('platform-kernel', registry);
  assert.deepEqual(kernel.dependsOn, [], 'the shared kernel must not depend on any domain');
  for (const domain of registry.domains) {
    if (domain.id === 'platform-kernel') continue;
    assert.ok(
      kernel.mustNotDependOn.includes(domain.id) || domain.kind === 'governance' || domain.kind === 'template',
      `platform-kernel must explicitly forbid depending on '${domain.id}'`,
    );
  }
});

test('the compatibility layer may not become the new monolith', () => {
  const compat = getDomain('compatibility', registry);
  for (const forbidden of ['workflow', 'execution', 'storage', 'node-registry', 'credentials', 'legacy-rest']) {
    assert.ok(
      compat.mustNotDependOn.includes(forbidden),
      `the compatibility layer must be forbidden from depending on '${forbidden}'`,
    );
  }
});

test('every temporary allowance is owned and has a deadline', () => {
  assert.ok(registry.allowances.length > 0, 'the honest state of the tree includes some temporary reach');
  for (const allowance of registry.allowances) {
    assert.ok(allowance.reason, `${allowance.id}: reason`);
    assert.ok(allowance.resolutionOwner, `${allowance.id}: resolutionOwner`);
    assert.ok(allowance.resolveBy, `${allowance.id}: resolveBy`);
    assert.ok(allowance.resolution, `${allowance.id}: resolution plan`);
    assert.ok(existsSync(join(APP_ROOT, allowance.file)), `${allowance.id}: '${allowance.file}' must exist`);
  }
});

/* --------------------------------------------------------- §4 error contract */

test('error codes are stable machine-readable identifiers', () => {
  // The invariant is COMPATIBILITY, not a frozen string. Publishing a new code
  // is a MINOR bump under the contract's own rules, and pinning the exact
  // version made every such addition look like a regression — which trains the
  // reader to edit the assertion rather than think about it. What must never
  // change silently is the MAJOR: that is the number a consumer depends on.
  assert.match(ERROR_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(ERROR_CONTRACT_VERSION.split('.')[0], '1',
    'a MAJOR bump means codes were removed or re-statused — consumers must be migrated deliberately');
  for (const required of [
    'credential.not_found',
    'workflow.not_found',
    'execution.timeout',
    'auth.unauthorized',
    'storage.not_found',
    'unsupported',
  ]) {
    assert.ok(isErrorCode(required), `'${required}' must be a published error code`);
  }
  assert.equal(statusForCode('workflow.not_found'), 404);
  assert.equal(statusForCode('unsupported'), 501);
  assert.equal(statusForCode('auth.unauthorized'), 401);
});

test('error codes carry no display language and belong to a declared namespace', () => {
  const namespaces = new Set(registry.domains.map((domain) => domain.errorNamespace));
  namespaces.add('compat');
  for (const entry of ERROR_CODES) {
    assert.match(entry.code, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9_]*)?$/, `code '${entry.code}' must be a lowercase identifier`);
    assert.ok(typeof entry.status === 'number', `code '${entry.code}' must declare a status`);
    if (entry.code === 'unsupported') continue;
    assert.ok(namespaces.has(entry.code.split('.')[0]), `code '${entry.code}' uses an unregistered namespace`);
  }
  // A code is identity, not a message: the summary is developer-facing English
  // and the frontend owns presentation. Nothing here ships translations.
  const contractDir = join(APP_ROOT, 'src', 'lego', 'contracts');
  const raw = readFileSync(join(contractDir, 'errors.contract.json'), 'utf8');
  assert.equal(raw.includes('"translations"'), false, 'the backend must not ship language packs');
});

test('inventing an error code fails loudly', () => {
  assert.throws(() => errorCode('workflow.invented_code'), /unknown error code/);
  assert.throws(() => assertErrorCode('nope.nope'), /unknown error code/);
  assert.equal(assertErrorCode('execution.timeout'), 'execution.timeout');
  assert.ok(codesForNamespace('workflow').length >= 3);
});

/* ------------------------------------------------------------- §5 versioning */

test('every locked contract points at real files, real exports and real tests', () => {
  for (const contract of registry.contractLock.contracts) {
    assert.match(contract.version, /^\d+\.\d+\.\d+$/, `${contract.id}: version`);
    assert.ok(registry.agents[contract.owner], `${contract.id}: owner must be a declared agent`);
    assert.ok(getDomain(contract.domain, registry), `${contract.id}: domain`);
    assert.ok(contract.tests.length > 0, `${contract.id}: contract tests`);
    for (const surface of contract.surface) {
      assert.ok(existsSync(join(APP_ROOT, surface)), `${contract.id}: missing surface file '${surface}'`);
    }
    for (const testPath of contract.tests) {
      assert.ok(
        existsSync(resolve(APP_ROOT, '..', '..', testPath)),
        `${contract.id}: missing contract test '${testPath}'`,
      );
    }
  }
});

test('the versioning policy states what a breaking change is', () => {
  const policy = registry.contractLock.policy;
  assert.ok(policy.breaking.length >= 3);
  assert.ok(policy.minor.length >= 1);
  assert.ok(policy.rule.includes('major'));
});

/* -------------------------------------------------------- §6 reference LEGO */

test('the reference LEGO demonstrates the public/private split', () => {
  const lego = createReferenceLego();
  assert.equal(lego.capability, REFERENCE_CAPABILITY);
  assert.equal(getCapability(REFERENCE_CAPABILITY, registry).domain, 'reference-lego');

  const written = lego.put({ key: 'a', value: 1 });
  assert.equal(written.revision, 1);
  assert.equal(lego.get('a').value, 1);
  assert.equal(lego.has('missing'), false);

  // Errors carry contract identity, not HTTP transport.
  try {
    lego.get('missing');
    assert.fail('expected a ReferenceError');
  } catch (error) {
    assert.ok(error instanceof ReferenceError);
    assert.equal(error.code, 'storage.not_found');
    assert.equal(error.status, undefined, 'a domain error must not carry an HTTP status');
  }

  // The port exposes behaviour only — no internal structure leaks out.
  assert.deepEqual(Object.keys(lego).sort(), ['capability', 'get', 'has', 'put', 'version']);
  assert.ok(Object.isFrozen(lego));
});

test('the reference LEGO keeps its implementation private', () => {
  const domain = getDomain('reference-lego', registry);
  assert.deepEqual(domain.public, ['src/reference-lego/contract']);
  assert.equal(isPublicPath('src/reference-lego/contract/index.mjs', domain), true);
  assert.equal(isPublicPath('src/reference-lego/internal/store.mjs', domain), false);
  assert.equal(domain.status, 'template', 'the reference LEGO must never become a production feature');
  const card = JSON.parse(readFileSync(join(APP_ROOT, 'src/reference-lego/lego.json'), 'utf8'));
  assert.equal(card.mounted, false, 'the template must not be mounted on any route');
});

/* ------------------------------------------------------- §7 architecture gate */

test('the architecture gate is green on the current tree', () => {
  const violations = runGate({ registry });
  assert.deepEqual(
    violations.map((violation) => `${violation.rule} ${violation.file}: ${violation.message}`),
    [],
  );
});

test('the architecture gate detects real forbidden dependencies', () => {
  const results = runSelftest();
  assert.ok(results.length >= 5, 'the selftest must cover several forbidden patterns');
  for (const result of results) {
    assert.ok(result.detected, `undetected: ${result.name} (saw ${result.saw.join(', ') || 'nothing'})`);
  }
  // Specifically the three patterns P2.6 names as must-detect.
  const names = CASES.map((entry) => entry.name).join(' | ');
  assert.match(names, /storage internal reaches into workflow internal/);
  assert.match(names, /execution internal reaches into workflow internal/);
  assert.match(names, /node registry reaches into credential\/storage persistence/);
});

test('the gate does not simply flag everything (negative control)', () => {
  const control = runNegativeControl();
  assert.equal(control.clean, true, `a correct file was flagged: ${JSON.stringify(control.violations)}`);
});

test('the legacy strangler zone is frozen and documented', () => {
  assert.equal(registry.legacy.frozen, true);
  assert.deepEqual(registry.legacy.files, ['src/rest/routes.mjs']);
  assert.ok(registry.legacy.custodian);
  assert.ok(registry.legacy.rules.length >= 3);
  assert.ok(Object.keys(registry.legacy.migrationTargets).length >= 5);
  for (const target of Object.values(registry.legacy.migrationTargets)) {
    assert.ok(getDomain(target, registry), `migration target '${target}' must be a registered domain`);
  }
});

test('the runtime capability table and the LEGO registry cannot drift apart', () => {
  const result = checkCapabilityConformance(registry);
  assert.deepEqual(result.problems.map((problem) => `${problem.kind}: ${problem.message}`), []);
  assert.ok(result.checked >= 20, 'every REST capability the compat layer advertises must be checked');
});

test('every capability the frontend can observe names a real owning agent', () => {
  for (const capability of listCapabilities(registry)) {
    assert.ok(registry.agents[capability.owner], `capability '${capability.id}' has unknown owner`);
    assert.ok(capability.phase, `capability '${capability.id}' must declare a phase`);
    assert.ok(DOMAIN_STATUS.includes(capability.status), `capability '${capability.id}' status`);
  }
});

test('no Rust implementation was smuggled into the backend foundation', () => {
  const capabilities = listCapabilities(registry);
  assert.ok(capabilities.length > 20, 'the capability registry must describe the backend');
  for (const path of ['src/lego', 'src/reference-lego']) {
    assert.ok(existsSync(join(APP_ROOT, path)));
  }
  assert.equal(existsSync(join(APP_ROOT, 'src', 'lego', 'Cargo.toml')), false);
});
