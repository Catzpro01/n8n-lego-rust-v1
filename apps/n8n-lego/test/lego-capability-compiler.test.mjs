/**
 * P6.8 — Capability compiler + runtime locality. Contract `node.capability@0.1.0`.
 *
 * Matrix: the host profile (a host that cannot say what it is cannot be trusted
 * with the decision), the all-or-nothing capability grant (no partial plans), the
 * DELEGATED runtime selection (measured: P6.1 capabilities are the foundation's
 * trust axis, not `node.portability`'s registry axis, so nothing is fabricated
 * and a plan states whether it delegated), capabilities constraining locality
 * (code execution needs isolation), the trust label staying outside both the
 * decision and its fingerprint, and the scope walls.
 *
 * Epoch-era declarations are real: the same P6.1 shape P6.2 compiles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODE_PORTABILITY_CONTRACT } from '../src/lego/node-portability.mjs';
import {
  CAPABILITY_CLASS_PRECEDENCE,
  CAPABILITY_COMPILER_CONTRACT,
  CAPABILITY_COMPILER_CONTRACT_VERSION,
  CAPABILITY_COMPILER_INPUT_SCHEMA_VERSION,
  CAPABILITY_COMPILER_OPERATIONS,
  CAPABILITY_COMPILER_PERMISSIONS,
  CAPABILITY_COMPILER_REASONS,
  CAPABILITY_COMPILER_RULES,
  CAPABILITY_COMPILER_SCHEMA_VERSION,
  CAPABILITY_DECISIONS,
  CAPABILITY_ISOLATION_REQUIREMENTS,
  CapabilityCompilerError,
  DELEGATION_SOURCES,
  FAILURE_BOUNDARY_ORDER,
  canPortPlan,
  candidateLocalities,
  capabilitySelectionPolicy,
  compileCapabilityPlan,
  describeCapabilityPlan,
  explainCapabilityPlan,
  hostProfile,
  isCapabilityPlan,
  portabilityClassOf,
  portabilityDeclarationOf,
  requiredIsolationOf,
  verifyCapabilityPlan,
} from '../src/lego/capability-compiler.mjs';

/* ------------------------------------------------------------------ fixtures */

const declaration = (overrides = {}) => ({
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  package: 'n8n-nodes-base',
  packageVersion: '2.9.1',
  vendor: 'n8n',
  contractVersion: '0.1.0',
  implementationVersion: '0.1.0',
  digest: `sha256:${'a'.repeat(64)}`,
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@2.9.1' },
  capabilities: ['network', 'secrets'],
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
});

/** The node's OWN `node.portability` declaration, in THAT domain's vocabulary. */
const portability = (overrides = {}) => ({
  nodeId: 'n8n-nodes-base.httpRequest',
  contract: 'n8n.http-request@1.0.0',
  portability: { class: 'NETWORK' },
  requiredCapabilities: ['runtime.http-server'],
  requiredPermissions: ['webhook:receive'],
  schemas: { input: { type: 'object' }, output: { type: 'object' } },
  ...overrides,
});

const profile = (overrides = {}) => hostProfile({
  hostId: 'host-1', capabilities: ['network', 'secrets'], runtimes: ['js-compat'], failureBoundary: 'sandboxed', ...overrides,
});
const tlsHost = () => profile({
  hostId: 'host-2', capabilities: ['network', 'secrets'], runtimes: ['rust-native'], failureBoundary: 'worker-isolated',
});
const richHost = () => profile({
  hostId: 'host-4',
  capabilities: ['network', 'secrets', 'subprocess', 'native'],
  runtimes: ['js-compat', 'rust-native', 'wasm', 'remote-worker'],
  failureBoundary: 'worker-isolated',
});
const refusalOf = (input) => {
  const plan = compileCapabilityPlan(input);
  assert.equal(plan.ok, false);
  return plan;
};
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
  assert.equal(CAPABILITY_COMPILER_CONTRACT, 'node.capability@0.1.0');
  assert.equal(CAPABILITY_COMPILER_CONTRACT_VERSION, '0.1.0');
  assert.ok(Number.isInteger(CAPABILITY_COMPILER_SCHEMA_VERSION) && CAPABILITY_COMPILER_SCHEMA_VERSION >= 1);
  assert.deepEqual([...CAPABILITY_COMPILER_OPERATIONS], ['compile', 'explain', 'delegate']);
  assert.deepEqual([...CAPABILITY_COMPILER_PERMISSIONS], ['node:read']);
  assert.equal(CAPABILITY_COMPILER_INPUT_SCHEMA_VERSION, 1);
});

test('the vocabularies are closed, prefixed and quotable', () => {
  assert.equal(new Set(CAPABILITY_COMPILER_REASONS).size, CAPABILITY_COMPILER_REASONS.length);
  for (const reason of CAPABILITY_COMPILER_REASONS) {
    assert.match(reason, /^capability\.[a-z]+$/);
  }
  assert.deepEqual([...CAPABILITY_DECISIONS], ['granted', 'denied']);
  assert.deepEqual([...DELEGATION_SOURCES], ['caller', 'none']);
  assert.deepEqual([...FAILURE_BOUNDARY_ORDER], ['in-process-safe', 'sandboxed', 'worker-isolated']);
  assert.deepEqual([...capabilitySelectionPolicy()], ['JS', 'WASM', 'RUST_NATIVE', 'REMOTE']);
  assert.equal(Object.isFrozen(CAPABILITY_COMPILER_RULES), true);
  assert.equal(typeof CAPABILITY_COMPILER_RULES.trust, 'string');
  assert.match(CAPABILITY_COMPILER_RULES.allOrNothing, /granted in full/);
});

test('the isolation requirements and the class precedence are the documented ones', () => {
  assert.deepEqual({ ...CAPABILITY_ISOLATION_REQUIREMENTS }, {
    network: 'in-process-safe',
    filesystem: 'in-process-safe',
    secrets: 'in-process-safe',
    env: 'in-process-safe',
    subprocess: 'sandboxed',
    native: 'worker-isolated',
  });
  assert.deepEqual([...CAPABILITY_CLASS_PRECEDENCE], ['PURE', 'ENVIRONMENT_SPECIFIC', 'API', 'NETWORK', 'FILESYSTEM', 'NATIVE_PROCESS']);
});

/* --------------------------------------------------------------- host profile */

test('a host profile is validated, deduplicated, sorted and frozen', () => {
  const host = profile({ capabilities: ['secrets', 'network', 'network'], runtimes: ['rust-native', 'js-compat'] });
  assert.deepEqual([...host.capabilities], ['network', 'secrets']);
  assert.deepEqual([...host.runtimes], ['js-compat', 'rust-native']);
  assert.equal(host.hostId, 'host-1');
  assert.equal(host.failureBoundary, 'sandboxed');
  assert.equal(Object.isFrozen(host), true);
  assert.equal(Object.isFrozen(host.capabilities), true);
  assert.deepEqual(Object.keys(host).sort(), ['capabilities', 'environment', 'failureBoundary', 'hostId', 'runtimes']);
});

test('a host that names an unknown capability, runtime or boundary is refused', () => {
  throwsWith(() => profile({ capabilities: ['quantum'] }), 'capability.unknown');
  throwsWith(() => profile({ runtimes: ['gpu'] }), 'capability.unknown');
  throwsWith(() => profile({ failureBoundary: 'enclave' }), 'capability.unknown');
  throwsWith(() => profile({ capabilities: 'network' }), 'capability.host');
  throwsWith(() => profile({ environment: { HOME: {} } }), 'capability.host');
});

test('an anonymous host and a host with no runtime are refused, not defaulted', () => {
  throwsWith(() => hostProfile({ capabilities: ['network'], runtimes: ['js-compat'], failureBoundary: 'sandboxed' }), 'capability.host');
  throwsWith(() => profile({ runtimes: [] }), 'capability.runtime');
  throwsWith(() => hostProfile(), 'capability.host');
});

test('a half-typed host is API misuse, not a plan', () => {
  throwsWith(() => compileCapabilityPlan({ declaration: declaration(), host: { hostId: 'h' } }), 'capability.host');
  throwsWith(() => compileCapabilityPlan({ declaration: declaration(), host: null }), 'capability.host');
  throwsWith(() => compileCapabilityPlan({
    declaration: declaration(), host: { hostId: 'h', capabilities: ['network'], runtimes: ['gpu'], failureBoundary: 'sandboxed' },
  }), 'capability.unknown');
});

/* ------------------------------------------- derived locality, stated honestly */

test('with no portability declaration the plan derives the target and says so', () => {
  const plan = compileCapabilityPlan({ declaration: declaration(), host: tlsHost() });
  assert.equal(plan.ok, true);
  assert.equal(plan.identity, 'n8n-nodes-base.httpRequest@4.4');
  assert.equal(plan.runtime, 'rust-native');
  assert.equal(plan.locality, 'ISOLATED_PROCESS');
  assert.equal(plan.portabilityTarget, 'JS');
  assert.equal(plan.portabilityClass, 'NETWORK');
  assert.equal(plan.delegation.performed, false);
  assert.equal(plan.delegation.source, 'none');
  assert.equal(plan.delegation.reason, 'capability.delegation.none');
  assert.equal(plan.delegation.declaration, null);
  assert.equal(plan.delegation.selected, null);
  assert.equal(plan.delegation.policy, null);
  assert.equal(isCapabilityPlan(plan), true);
});

test('a plan without a delegation explains the absence instead of implying a choice', () => {
  const plan = compileCapabilityPlan({ declaration: declaration(), host: tlsHost() });
  const sentence = explainCapabilityPlan(plan);
  assert.match(sentence, /nothing was delegated/);
  assert.match(sentence, /derived from the runtime locality model/);
  const summary = describeCapabilityPlan(plan);
  assert.equal(summary.delegated, false);
  assert.equal(summary.delegationSource, 'none');
  assert.equal(summary.planDigest, plan.planDigest);
  assert.equal(canPortPlan(plan, 'JS').ok, false);
  assert.equal(canPortPlan(plan, 'JS').reason, 'capability.delegation.none');
  assert.equal(canPortPlan(plan, 'JS').portable, null);
});

test('the same declaration on the same host compiles to the same plan', () => {
  const first = compileCapabilityPlan({ declaration: declaration(), host: tlsHost() });
  const second = compileCapabilityPlan({ declaration: declaration(), host: tlsHost() });
  assert.equal(first.planDigest, second.planDigest);
  assert.equal(verifyCapabilityPlan(first, { declaration: declaration(), host: tlsHost() }).ok, true);
});

/* --------------------------------------------------------- real delegation */

test('a supplied portability declaration is delegated to node.portability', () => {
  const plan = compileCapabilityPlan({ declaration: declaration(), host: tlsHost(), portability: portability() });
  assert.equal(plan.ok, true);
  assert.equal(plan.delegation.performed, true);
  assert.equal(plan.delegation.source, 'caller');
  assert.equal(plan.delegation.reason, null);
  assert.ok(plan.delegation.selected !== null);
  assert.ok(Array.isArray(plan.delegation.candidates));
  assert.ok(Array.isArray(plan.delegation.rejected));
  assert.ok(Array.isArray(plan.delegation.policy));
  assert.equal(plan.delegation.declaration.contract, 'n8n.http-request@1.0.0');
  assert.deepEqual([...plan.delegation.declaration.requiredPermissions], ['webhook:receive']);
  assert.equal(plan.portabilityClass, 'NETWORK');
  assert.match(explainCapabilityPlan(plan), /selected by node.portability/);
  assert.equal(describeCapabilityPlan(plan).delegated, true);
  assert.equal(canPortPlan(plan, 'RUST_NATIVE').ok, true);
  assert.equal(typeof canPortPlan(plan, 'RUST_NATIVE').portable, 'boolean');
});

test('the delegated answer is the domain answer, quoted whole', () => {
  const plan = compileCapabilityPlan({ declaration: declaration(), host: richHost(), portability: portability() });
  assert.equal(plan.portabilityTarget, plan.delegation.selected.target);
  assert.equal(plan.portabilityClass, plan.delegation.declaration.portability.class);
  assert.equal(plan.delegation.contract, NODE_PORTABILITY_CONTRACT);
  assert.equal(NODE_PORTABILITY_CONTRACT, 'node.portability@1.0.0');
  assert.equal(plan.delegation.selected.target, plan.delegation.candidates[0].target);
});

test('portabilityDeclarationOf reports its source and refuses a neighbour declaration', () => {
  assert.equal(portabilityDeclarationOf(declaration()).source, 'none');
  assert.equal(portabilityDeclarationOf(declaration()).declaration, null);
  const resolved = portabilityDeclarationOf(declaration(), { portability: portability() });
  assert.equal(resolved.source, 'caller');
  assert.equal(resolved.nodeId, 'n8n-nodes-base.httpRequest');
  assert.equal(resolved.contract, 'n8n.http-request@1.0.0');
  throwsWith(
    () => compileCapabilityPlan({ declaration: declaration(), host: tlsHost(), portability: portability({ nodeId: 'n8n-nodes-base.slack' }) }),
    'capability.delegation',
  );
  throwsWith(
    () => compileCapabilityPlan({ declaration: declaration(), host: tlsHost(), portability: portability({ contract: 'http-request' }) }),
    'lego.contract_violation',
  );
});

test('a class-conflicting declaration fails closed at the domain', () => {
  const plan = refusalOf({
    declaration: declaration(), host: tlsHost(), portability: portability({ portability: { class: 'PURE' } }),
  });
  assert.equal(plan.reason, 'capability.runtime');
  assert.match(plan.errors[0].message, /node.portability selected no runtime target/);
});

test('a delegated plan verifies only against the same declaration, host and portability declaration', () => {
  const plan = compileCapabilityPlan({ declaration: declaration(), host: tlsHost(), portability: portability() });
  assert.equal(verifyCapabilityPlan(plan, { declaration: declaration(), host: tlsHost(), portability: portability() }).ok, true);
  assert.equal(verifyCapabilityPlan(plan, { declaration: declaration(), host: profile(), portability: portability() }).ok, false);
  assert.equal(verifyCapabilityPlan(plan, { declaration: declaration({ capabilities: ['network'] }), host: tlsHost(), portability: portability() }).ok, false);

  // Measured fact, recorded as a test: here the two capability axes agree, so
  // dropping the declaration leaves the DECISION unchanged — and verification
  // says exactly that instead of inventing a difference.
  assert.equal(plan.portabilityClass, portabilityClassOf(declaration()));
  assert.equal(verifyCapabilityPlan(plan, { declaration: declaration(), host: tlsHost() }).ok, true);

  // Where the axes disagree, dropping the declaration changes the decision.
  const nativePlan = compileCapabilityPlan({
    declaration: declaration(),
    host: tlsHost(),
    portability: portability({ portability: { class: 'NATIVE_PROCESS' }, requiredPermissions: ['worker:admin'] }),
  });
  assert.equal(nativePlan.ok, true);
  assert.equal(nativePlan.portabilityClass, 'NATIVE_PROCESS');
  assert.notEqual(nativePlan.planDigest, plan.planDigest);
  assert.equal(verifyCapabilityPlan(nativePlan, { declaration: declaration(), host: tlsHost() }).ok, false);
});

/* --------------------------------------------------------- all-or-nothing */

test('one unauthorized capability refuses the whole plan, with no partial grant', () => {
  const plan = refusalOf({ declaration: declaration({ capabilities: ['network', 'subprocess'] }), host: tlsHost() });
  assert.equal(plan.reason, 'capability.denied');
  assert.equal(plan.errors[0].code, 'capability.denied');
  assert.match(plan.errors[0].message, /'subprocess'/);
  assert.match(plan.errors[0].message, /granted in full/);
  assert.deepEqual([...plan.granted], []);
  assert.deepEqual([...plan.denied], []);
  assert.equal(plan.locality, null);
  assert.equal(plan.planDigest, null);
  assert.equal(plan.runtime, undefined);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.errors), true);
  assert.equal(isCapabilityPlan(plan), false);
});

test('every unmet capability is named at once, not one per attempt', () => {
  const plan = refusalOf({ declaration: declaration({ capabilities: ['network', 'subprocess', 'native'] }), host: tlsHost() });
  assert.equal(plan.errors.length, 2);
  assert.deepEqual(plan.errors.map((error) => error.field), ['capabilities', 'capabilities']);
  assert.match(plan.errors.map((error) => error.message).join(' '), /'subprocess'/);
  assert.match(plan.errors.map((error) => error.message).join(' '), /'native'/);
});

test('an unknown capability and an uncompilable declaration never reach a plan', () => {
  const unknown = refusalOf({ declaration: declaration({ capabilities: ['network', 'quantum'] }), host: tlsHost() });
  assert.equal(unknown.reason, 'capability.declaration');
  assert.equal(unknown.errors[0].code, 'capability.declaration');
  assert.equal(refusalOf({ declaration: { type: 'n8n-nodes-base.httpRequest' }, host: tlsHost() }).reason, 'capability.declaration');
  assert.equal(refusalOf({ declaration: null, host: tlsHost() }).reason, 'capability.declaration');
});

/* -------------------------------------------------------------- locality */

test('the runtimes a host offers decide the locality, and the host ceiling is respected', () => {
  const onlyJs = compileCapabilityPlan({ declaration: declaration({ capabilities: ['network'] }), host: profile() });
  assert.equal(onlyJs.runtime, 'js-compat');
  assert.equal(onlyJs.locality, 'IN_PROCESS');
  assert.equal(onlyJs.failureBoundary, 'in-process-safe');
  assert.equal(onlyJs.portabilityTarget, 'JS');
  const remote = compileCapabilityPlan({ declaration: declaration({ capabilities: ['network'], runtimeLocality: 'remote-worker' }), host: richHost() });
  assert.equal(remote.ok, true);
  assert.equal(remote.runtime, 'remote-worker');
  assert.equal(remote.locality, 'REMOTE');
  assert.equal(remote.portabilityTarget, 'REMOTE');
});

test('a host with no runtime for the decision refuses and names the target', () => {
  const plan = refusalOf({ declaration: declaration({ capabilities: ['network'], runtimeLocality: 'wasm' }), host: profile() });
  assert.equal(plan.reason, 'capability.runtime');
  assert.match(plan.errors[0].message, /target WASM/);
  assert.match(plan.errors[0].message, /js-compat/);
});

test('capabilities constrain locality: code execution demands isolation', () => {
  const willingButFlat = profile({ capabilities: ['network', 'secrets', 'subprocess'], failureBoundary: 'in-process-safe' });
  const tooFlat = refusalOf({ declaration: declaration({ capabilities: ['network', 'subprocess'] }), host: willingButFlat });
  assert.equal(tooFlat.reason, 'capability.boundary');
  assert.equal(tooFlat.errors[0].required, 'sandboxed');
  assert.equal(tooFlat.errors[0].offered, 'in-process-safe');
  assert.match(tooFlat.errors[0].message, /sharing an address space/);
  const native = compileCapabilityPlan({ declaration: declaration({ capabilities: ['native'] }), host: richHost() });
  assert.equal(native.ok, true);
  assert.equal(native.requiredBoundary, 'worker-isolated');
  assert.equal(native.failureBoundary, 'worker-isolated');
});

test('an isolation floor is not a preference: a running runtime below it is still refused', () => {
  const plan = refusalOf({ declaration: declaration({ capabilities: ['native'], runtimeLocality: 'wasm' }), host: richHost() });
  assert.equal(plan.reason, 'capability.boundary');
  assert.equal(plan.errors[0].required, 'worker-isolated');
  assert.deepEqual([...plan.errors[0].offered], ['sandboxed']);
  assert.deepEqual([...candidateLocalities(declaration({ capabilities: ['native'] }), richHost()).map((entry) => entry.failureBoundary)], ['worker-isolated', 'worker-isolated']);
});

test('the strongest isolation the host offers for the node wins', () => {
  const plan = compileCapabilityPlan({ declaration: declaration({ capabilities: ['network'] }), host: richHost() });
  assert.equal(plan.ok, true);
  assert.equal(plan.failureBoundary, 'worker-isolated');
  const candidates = candidateLocalities(declaration({ capabilities: ['network'] }), richHost());
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.map((entry) => entry.failureBoundary), ['worker-isolated', 'worker-isolated', 'sandboxed', 'in-process-safe']);
  assert.deepEqual(candidates.map((entry) => entry.runtime), ['remote-worker', 'rust-native', 'wasm', 'js-compat']);
});

test('an empty capability set is legal and stays in-process', () => {
  const plan = compileCapabilityPlan({ declaration: declaration({ capabilities: [] }), host: profile() });
  assert.equal(plan.ok, true);
  assert.deepEqual([...plan.declared], []);
  assert.deepEqual(plan.decisions, {});
  assert.equal(plan.requiredBoundary, 'in-process-safe');
  assert.equal(requiredIsolationOf(declaration({ capabilities: [] })), 'in-process-safe');
});

test('requiredIsolationOf reports the strongest need and portabilityClassOf the axis class', () => {
  assert.equal(requiredIsolationOf(declaration({ capabilities: ['env'] })), 'in-process-safe');
  assert.equal(requiredIsolationOf(declaration({ capabilities: ['network', 'subprocess'] })), 'sandboxed');
  assert.equal(requiredIsolationOf(declaration({ capabilities: ['native'] })), 'worker-isolated');
  assert.equal(portabilityClassOf(declaration({ capabilities: [] })), 'PURE');
  assert.equal(portabilityClassOf(declaration({ capabilities: ['env'] })), 'ENVIRONMENT_SPECIFIC');
  assert.equal(portabilityClassOf(declaration({ capabilities: ['secrets'] })), 'API');
  assert.equal(portabilityClassOf(declaration({ capabilities: ['network'] })), 'NETWORK');
  assert.equal(portabilityClassOf(declaration({ capabilities: ['filesystem'] })), 'FILESYSTEM');
  assert.equal(portabilityClassOf(declaration({ capabilities: ['native'] })), 'NATIVE_PROCESS');
  assert.equal(portabilityClassOf(declaration({ capabilities: [], runtimeLocality: 'remote-worker' })), 'REMOTE_BRIDGE');
});

test('candidateLocalities is a read: strongest first, host ceiling respected, misuse throws', () => {
  const ceiling = profile({ hostId: 'h', capabilities: ['network'], runtimes: ['js-compat', 'rust-native'], failureBoundary: 'sandboxed' });
  assert.deepEqual([...candidateLocalities(declaration({ capabilities: ['network'] }), ceiling).map((entry) => entry.runtime)], ['js-compat']);
  throwsWith(() => candidateLocalities({ type: 'n8n-nodes-base.httpRequest' }, profile()), 'capability.declaration');
  throwsWith(() => candidateLocalities(declaration(), { hostId: 'h' }), 'capability.host');
});

/* ---------------------------------------------------- trust is a label, never an authority */

test('the trust class travels in the plan, changes no decision and is outside the fingerprint', () => {
  const core = compileCapabilityPlan({ declaration: declaration({ trustClass: 'core' }), host: tlsHost() });
  const untrusted = compileCapabilityPlan({ declaration: declaration({ trustClass: 'untrusted' }), host: tlsHost() });
  assert.equal(core.trustClass, 'core');
  assert.equal(untrusted.trustClass, 'untrusted');
  assert.deepEqual([...core.granted], [...untrusted.granted]);
  assert.deepEqual(core.decisions, untrusted.decisions);
  assert.equal(core.runtime, untrusted.runtime);
  assert.equal(core.locality, untrusted.locality);
  assert.equal(core.failureBoundary, untrusted.failureBoundary);
  assert.equal(core.requiredBoundary, untrusted.requiredBoundary);
  assert.equal(core.planDigest, untrusted.planDigest);
});

test('the fingerprint moves with the decision and ignores the delegation record', () => {
  const base = compileCapabilityPlan({ declaration: declaration(), host: tlsHost() });
  const fewer = compileCapabilityPlan({ declaration: declaration({ capabilities: ['network'] }), host: tlsHost() });
  assert.notEqual(base.planDigest, fewer.planDigest);
  const delegated = compileCapabilityPlan({ declaration: declaration(), host: tlsHost(), portability: portability() });
  assert.equal(delegated.delegation.performed, true);
  assert.equal(delegated.portabilityTarget, base.portabilityTarget);
  assert.equal(delegated.planDigest, base.planDigest);
  assert.equal(describeCapabilityPlan(delegated).planDigest, describeCapabilityPlan(base).planDigest);
});

/* ----------------------------------------------------------- reads and guards */

test('the reads refuse a refusal: a refusal is not a plan', () => {
  const refusal = refusalOf({ declaration: declaration({ capabilities: ['native'] }), host: profile() });
  throwsWith(() => explainCapabilityPlan(refusal), 'lego.contract_violation');
  throwsWith(() => describeCapabilityPlan(refusal), 'lego.contract_violation');
  throwsWith(() => verifyCapabilityPlan(refusal, {}), 'lego.contract_violation');
  throwsWith(() => canPortPlan(refusal, 'JS'), 'lego.contract_violation');
  throwsWith(() => explainCapabilityPlan({ ok: true }), 'lego.contract_violation');
});

test('a portability target outside the vocabulary is refused before it is asked about', () => {
  const plan = compileCapabilityPlan({ declaration: declaration(), host: tlsHost(), portability: portability() });
  throwsWith(() => canPortPlan(plan, 'GPU'), 'capability.runtime');
});

test('every plan and refusal is frozen, and the error type is exported', () => {
  const plan = compileCapabilityPlan({ declaration: declaration(), host: tlsHost() });
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.granted), true);
  assert.equal(Object.isFrozen(plan.delegation), true);
  assert.equal(Object.isFrozen(compileCapabilityPlan({ declaration: declaration(), host: tlsHost() }).declared), true);
  assert.equal(new CapabilityCompilerError('x') instanceof Error, true);
  assert.equal(typeof explainCapabilityPlan(plan), 'string');
  assert.equal(typeof capabilitySelectionPolicy()[0], 'string');
});

/* ------------------------------------------------------------------ scope walls */

test('P6.8 is pure: no clock, no filesystem, no network, no execution and no pool', () => {
  const source = readFileSync(new URL('../src/lego/capability-compiler.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(']) {
    assert.equal(code.includes(forbidden), false, `the capability compiler must not reference ${forbidden}`);
  }
  assert.deepEqual(
    [...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]),
    ['node:crypto'],
    'the only node import is the hash used for planDigest: no I/O, no clock, no execution',
  );
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'a plan is a function of its inputs; a clock would make it unreproducible');
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
});

test('P6.8 stays inside its walls: no lease, no admission, no sandbox, no pool', () => {
  const source = readFileSync(new URL('../src/lego/capability-compiler.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['runtime-lease', 'node-residency', 'package-transaction', 'node-creator', 'quarantine', 'attest', 'node:vm', 'worker_threads', 'new Worker', 'spawn', 'child_process']) {
    assert.equal(code.includes(forbidden), false, `P6.8 must not reach into ${forbidden}: that belongs to a later or different contract`);
  }
  assert.equal(code.includes("from './node-portability.mjs'"), true, 'runtime selection is the domain contract\'s, and it is delegated to');
  assert.equal(code.includes('selectRuntime'), true);
});

/* --------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.capability');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, CAPABILITY_COMPILER_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/capability-compiler.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-capability-compiler.test.mjs']);
  assert.equal(rows[0].exports['src/lego/capability-compiler.mjs'].includes('compileCapabilityPlan'), true);
  assert.equal(rows[0].exports['src/lego/capability-compiler.mjs'].includes('verifyCapabilityPlan'), true);
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.8 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/capability-compiler.mjs'));
});
