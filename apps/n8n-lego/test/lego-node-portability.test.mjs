/**
 * P2.22 — Node Compatibility & Portability.
 *
 * Matrix: portability classes × runtime targets (§20), schema round-trip per
 * feature × target (§21), declared-facet differential (§22), fail-closed
 * reasons (§16), five-axis compatibility report (§10), policy-based selection
 * with no language favorite (§11), authority-free classification (§13/§14),
 * and the static walls: no Node Creator, no translation engine, no providers,
 * no model inference, no filesystem/network/process imports — one module, one
 * contract, boot payload untouched (its pins live in the frontend suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as portability from '../src/lego/node-portability.mjs';
import {
  CANONICAL_FIXTURES, CLASS_DECLARATION_RULES, COMPATIBILITY_AXES, DIFFERENTIAL_FACETS,
  MATRIX_STATUSES, NODE_PORTABILITY_CONTRACT, NODE_PORTABILITY_OPERATIONS,
  NODE_PORTABILITY_PERMISSIONS, NodePortabilityError, OVERALL_REASONS,
  PERMISSION_CATEGORIES, PORTABILITY_CLASSES, PORTABILITY_REASONS, PORTABILITY_TARGETS,
  REASON_AXIS, RUNTIME_MATRIX, RUNTIME_SELECTION_POLICY, SCHEMA_FEATURE_STATUSES,
  SCHEMA_STATUSES, canPort, canonicalizeSchema, compareImplementations,
  describePortability, roundTrip, schemaFeatures, schemaPortability,
  selectRuntime, validateNodeDeclaration,
} from '../src/lego/node-portability.mjs';
import { AGENT_MACHINE_OPERATIONS } from '../src/lego/agent-machine.mjs';

const HERE = new URL('.', import.meta.url);
const MODULE_PATH = join(HERE.pathname, '..', 'src', 'lego', 'node-portability.mjs');
const MODULE_SOURCE = readFileSync(MODULE_PATH, 'utf8');
const LOCK = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'contracts', 'contract-lock.json'), 'utf8'));
const DOMAINS = JSON.parse(readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'manifest', 'domains.json'), 'utf8'));

const NODE_DOMAIN = DOMAINS.domains.find((domain) => domain.id === 'node-registry');
const PORTABILITY_CAP = NODE_DOMAIN.capabilities.find((capability) => capability.id === 'node-registry.portability');
const LOCK_ROW = LOCK.contracts.find((row) => row.id === 'node.portability');

const portableSchemas = () => ({
  input: {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['name'],
    additionalProperties: false,
  },
  output: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  },
});

/** A structurally valid node of `cls` with overridable pieces. */
const mkNode = (cls, overrides = {}) => ({
  nodeId: `n-${cls.toLowerCase()}`,
  contract: 'demo.portable-node@1.0.0',
  portability: { class: cls, ...(overrides.portability ?? {}) },
  requiredCapabilities: overrides.requiredCapabilities ?? [],
  requiredPermissions: overrides.requiredPermissions ?? [],
  schemas: overrides.schemas ?? portableSchemas(),
  ...(overrides.extra ?? {}),
});

const reasons = (answer) => answer.reasons.map((entry) => entry.reason);

/* ================================================================ *
 * §23 Contract: lock row, capability, module — three-way parity
 * ================================================================ */

test('the contract string is the exact locked identity', () => {
  assert.equal(NODE_PORTABILITY_CONTRACT, 'node.portability@1.0.0');
  assert.equal(LOCK_ROW.version, '1.0.0');
  assert.equal(LOCK_ROW.status, 'implemented');
  assert.equal(LOCK_ROW.domain, 'node-registry');
  assert.equal(LOCK_ROW.owner, 'manager');
});

test('the contract-lock row names real exports, real ops, the real test file — 27 rows total', () => {
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(LOCK.contracts.length, 100, 'P2.22 twenty-seventh .. P2.26 thirty-second (ai.provider-declaration), P3 Slice A the thirty-third (workflow.graph), P3 Slice D the thirty-fourth (execution.frontier), P3 Slice E the thirty-fifth (execution.state-stream), P3 Slice H the thirty-sixth (workflow.dna) lock rows; P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.deepEqual([...LOCK_ROW.operations], [...NODE_PORTABILITY_OPERATIONS]);
  const exported = LOCK_ROW.exports['src/lego/node-portability.mjs'];
  assert.deepEqual([...exported].sort(), Object.keys(portability).sort(),
    'the lock exports exactly what the module exports');
  assert.deepEqual(LOCK_ROW.tests, ['apps/n8n-lego/test/lego-node-portability.test.mjs']);
  assert.ok(LOCK_ROW.notes.includes('fail-closed') && LOCK_ROW.notes.includes('portability'));
});

test('the domain capability, lock row and module agree on operations and permissions', () => {
  assert.deepEqual(PORTABILITY_CAP.operations.map((op) => op.name), [...NODE_PORTABILITY_OPERATIONS]);
  assert.deepEqual([...PORTABILITY_CAP.permissions].sort(), [...NODE_PORTABILITY_PERMISSIONS].sort());
  for (const op of PORTABILITY_CAP.operations) {
    assert.ok(NODE_PORTABILITY_PERMISSIONS.includes(op.permission), `${op.name} permission is published`);
    assert.equal(op.interaction, 'call');
    assert.equal(op.idempotent, true);
  }
  assert.ok(NODE_DOMAIN.paths.includes('src/lego/node-portability.mjs'), 'the domain owns the file');
  assert.equal(PORTABILITY_CAP.status, 'implemented');
  // never an agent-machine operation — canPort/select/describePortability are new names, no collisions
  for (const op of NODE_PORTABILITY_OPERATIONS) {
    assert.ok(!AGENT_MACHINE_OPERATIONS.includes(op), `${op} does not shadow an agent machine operation`);
  }
});

test('classes, targets and statuses are closed canonical sets with no competing synonyms', () => {
  assert.deepEqual([...PORTABILITY_CLASSES], [
    'PURE', 'API', 'NETWORK', 'FILESYSTEM',
    'NATIVE_PROCESS', 'ENVIRONMENT_SPECIFIC', 'REMOTE_BRIDGE',
  ]);
  assert.deepEqual([...PORTABILITY_TARGETS], ['JS', 'WASM', 'RUST_NATIVE', 'REMOTE']);
  assert.deepEqual([...MATRIX_STATUSES], ['SUPPORTED', 'UNSUPPORTED', 'CONDITIONAL']);
  assert.deepEqual([...SCHEMA_STATUSES], ['SUPPORTED', 'UNSUPPORTED', 'LOSSY']);
  for (const banned of ['networked', 'remote-only', 'server', 'local-fs', 'native-host']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`, 'i').test(MODULE_SOURCE),
      `the module never spells the competing synonym '${banned}'`);
  }
});

/* ================================================================ *
 * §12 Runtime matrix completeness + the documented example row
 * ================================================================ */

test('the runtime matrix is complete: every class × every target carries a status and closed conditions', () => {
  assert.deepEqual(Object.keys(RUNTIME_MATRIX).sort(), [...PORTABILITY_CLASSES].sort());
  for (const cls of PORTABILITY_CLASSES) {
    assert.deepEqual(Object.keys(RUNTIME_MATRIX[cls]).sort(), [...PORTABILITY_TARGETS].sort(), `${cls} row`);
    for (const target of PORTABILITY_TARGETS) {
      const cell = RUNTIME_MATRIX[cls][target];
      assert.ok(MATRIX_STATUSES.includes(cell.status), `${cls}/${target} status`);
      for (const condition of cell.conditions) {
        assert.ok(['transport-context', 'remote-authority', 'capability-host', 'environment-context'].includes(condition),
          `${cls}/${target} condition '${condition}' is declared`);
      }
    }
  }
});

test('the documented example row holds: PURE is supported locally, conditional on remote', () => {
  assert.equal(RUNTIME_MATRIX.PURE.JS.status, 'SUPPORTED');
  assert.equal(RUNTIME_MATRIX.PURE.WASM.status, 'SUPPORTED');
  assert.equal(RUNTIME_MATRIX.PURE.RUST_NATIVE.status, 'SUPPORTED');
  assert.equal(RUNTIME_MATRIX.PURE.REMOTE.status, 'CONDITIONAL');
  assert.deepEqual([...RUNTIME_MATRIX.PURE.REMOTE.conditions], ['transport-context']);
});

test('local runtimes are UNSUPPORTED for REMOTE_BRIDGE — a local-only runtime is refused', () => {
  for (const target of ['JS', 'WASM', 'RUST_NATIVE']) {
    assert.equal(RUNTIME_MATRIX.REMOTE_BRIDGE[target].status, 'UNSUPPORTED', `${target} is local-only`);
  }
  assert.equal(RUNTIME_MATRIX.REMOTE_BRIDGE.REMOTE.status, 'CONDITIONAL');
});

test('no cell claims SUPPORTED while hiding an unchecked condition', () => {
  for (const cls of PORTABILITY_CLASSES) {
    for (const target of PORTABILITY_TARGETS) {
      const cell = RUNTIME_MATRIX[cls][target];
      if (cell.status === 'SUPPORTED') assert.equal(cell.conditions.length, 0, `${cls}/${target}`);
      if (cell.status === 'UNSUPPORTED') assert.equal(cell.conditions.length, 0, `${cls}/${target}`);
      if (cell.status === 'CONDITIONAL') assert.ok(cell.conditions.length > 0, `${cls}/${target} states its conditions`);
    }
  }
});

/* ================================================================ *
 * §8 Schema subset: SUPPORTED / UNSUPPORTED / LOSSY — no silent coercion
 * ================================================================ */

test('every portable-subset feature is declared with an explicit status', () => {
  for (const feature of ['scalar', 'object', 'array', 'nullable', 'enum', 'required', 'optional', 'constraints', 'default', 'additionalProperties']) {
    assert.equal(SCHEMA_FEATURE_STATUSES[feature], 'SUPPORTED', `${feature}`);
  }
  assert.equal(SCHEMA_FEATURE_STATUSES.pattern, 'UNSUPPORTED', 'regex dialects are not portable');
  assert.equal(SCHEMA_FEATURE_STATUSES.union, 'UNSUPPORTED');
  assert.equal(SCHEMA_FEATURE_STATUSES.reference, 'UNSUPPORTED');
  assert.equal(SCHEMA_FEATURE_STATUSES.format, 'LOSSY', 'format semantics vary — lossy, refused');
  for (const status of Object.values(SCHEMA_FEATURE_STATUSES)) assert.ok(SCHEMA_STATUSES.includes(status));
});

test('the portable subset round-trips: scalar, object, array, nullable, enum, required, optional, constraints, default', () => {
  const cases = [
    { type: 'string', minLength: 1, maxLength: 8, default: 'x' },
    { type: 'number', minimum: 0, maximum: 10, default: 5 },
    { type: 'integer', minimum: -3 },
    { type: 'boolean', default: false },
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
    { type: 'array', items: { type: 'string', nullable: true } },
    { type: 'string', enum: ['a', 'b'], default: 'a' },
    { type: 'string', nullable: true },
  ];
  for (const schema of cases) {
    const features = schemaFeatures(schema);
    assert.ok(features.length > 0, 'features detected');
    assert.equal(schemaPortability(schema).portable, true, JSON.stringify(schema));
    for (const target of PORTABILITY_TARGETS) {
      if (RUNTIME_MATRIX.PURE[target].status === 'UNSUPPORTED') continue;
      const report = roundTrip(schema, target);
      assert.equal(report.equal, true, `${target}: ${JSON.stringify(schema)} → ${JSON.stringify(report)}`);
      assert.deepEqual(report.canonicalAgain, canonicalizeSchema(schema));
    }
  }
});

test('canonicalization is idempotent and never coerces values', () => {
  const schema = { type: 'object', properties: { z: { type: 'integer', maximum: 3 }, a: { type: 'string' } }, required: ['z'], additionalProperties: false };
  const once = canonicalizeSchema(schema);
  const twice = canonicalizeSchema(once);
  assert.deepEqual(once, twice);
  assert.deepEqual(Object.keys(once), ['additionalProperties', 'properties', 'required', 'type'], 'key order canonical, values untouched');
  assert.equal(once.properties.z.maximum, 3, 'value preserved');
});

test('UNSUPPORTED features refuse with schema-unsupported and an explicit detail', () => {
  for (const [schema, feature] of [
    [{ type: 'string', pattern: '^a' }, 'pattern'],
    [{ type: 'object', properties: {}, anyOf: [], additionalProperties: false }, 'union'],
    [{ $ref: '#/x' }, 'reference'],
    [{ type: 'foobar' }, 'type'],
    [{ type: 'string', contentEncoding: 'base64' }, 'contentEncoding'],
  ]) {
    const report = schemaPortability(schema);
    assert.equal(report.portable, false, JSON.stringify(schema));
    assert.ok(report.unsupported.some((entry) => entry.feature === feature),
      `${JSON.stringify(schema)} reports ${feature}: ${JSON.stringify(report.unsupported)}`);
    const rt = roundTrip(schema, 'JS');
    assert.equal(rt.equal, false);
    assert.equal(rt.reason, 'schema-unsupported', 'round-trip refuses too, deterministically');
  }
});

test('LOSSY refuses as schema-lossy — never a silent best-effort conversion', () => {
  const schema = { type: 'string', format: 'date-time' };
  const report = schemaPortability(schema);
  assert.equal(report.portable, false);
  assert.equal(report.lossy[0].feature, 'format');
  const rt = roundTrip(schema, 'JS');
  assert.equal(rt.equal, false);
  assert.equal(rt.reason, 'schema-lossy');
  assert.equal(rt.canonical, null, 'no half-converted output escapes');
});

test('structural schema errors throw lego.contract_violation with a field', () => {
  assert.throws(() => canonicalizeSchema('nope'), (error) => {
    assert.ok(error instanceof NodePortabilityError);
    assert.equal(error.code, 'lego.contract_violation');
    return true;
  });
  assert.throws(() => canonicalizeSchema({ type: 'array' }), /items/);
  assert.throws(() => canonicalizeSchema({ type: 'object', properties: { a: { type: 'string' } }, required: ['ghost'] }), /not declared/);
  assert.throws(() => canonicalizeSchema({ type: 'string', minLength: -1 }), /minLength/);
  assert.throws(() => canonicalizeSchema({ default: 42 }), /type/);
});

/* ================================================================ *
 * §20 Portability class test matrix
 * ================================================================ */

test('PURE: portable to JS, WASM and Rust; remote needs the transport context', () => {
  const node = mkNode('PURE');
  for (const target of ['JS', 'WASM', 'RUST_NATIVE']) {
    const answer = canPort(node, target);
    assert.equal(answer.overall, 'portable', `${target}: ${JSON.stringify(answer.reasons)}`);
    assert.equal(answer.portable, true);
  }
  const missing = canPort(node, 'REMOTE');
  assert.equal(missing.portable, false);
  assert.ok(reasons(missing).includes('transport-mismatch'));
  assert.equal(missing.reason, 'portability-incompatible');
  const present = canPort(node, 'REMOTE', { transport: 'ws-bridge' });
  assert.equal(present.overall, 'conditional', '§12 example: remote is conditional for PURE');
  assert.equal(present.portable, true);
});

test('API: valid capability ports; an API class must declare its capability; missing capability refuses', () => {
  const ok = mkNode('API', { requiredCapabilities: ['node-registry.catalog'] });
  assert.equal(canPort(ok, 'JS').overall, 'portable');
  const missing = mkNode('API', { requiredCapabilities: [] });
  const answer = canPort(missing, 'JS');
  assert.equal(answer.portable, false);
  assert.ok(reasons(answer).includes('missing-capability'));
  assert.equal(answer.reason, 'contract-incompatible');
  const unknown = mkNode('API', { requiredCapabilities: ['not.a-published.thing'] });
  assert.ok(reasons(canPort(unknown, 'JS')).includes('unknown-capability'));
});

test('API on WASM is conditional on the capability host — no host, no portability', () => {
  const node = mkNode('API', { requiredCapabilities: ['node-registry.catalog'] });
  const withoutHost = canPort(node, 'WASM');
  assert.equal(withoutHost.portable, false);
  assert.ok(reasons(withoutHost).includes('capability-host-missing'));
  assert.equal(withoutHost.reason, 'runtime-incompatible');
  const withHost = canPort(node, 'WASM', { hostCapabilities: ['node-registry.catalog'] });
  assert.equal(withHost.overall, 'conditional');
  const partialHost = canPort(node, 'WASM', { hostCapabilities: ['something.else'] });
  assert.equal(partialHost.portable, false);
});

test('NETWORK: permission present ports; permission missing refuses; a filesystem word does not authorize network', () => {
  const ok = mkNode('NETWORK', { requiredCapabilities: ['webhook.ingress'], requiredPermissions: ['webhook:receive'] });
  assert.equal(canPort(ok, 'JS').overall, 'portable');
  const noPermission = mkNode('NETWORK', { requiredCapabilities: ['webhook.ingress'], requiredPermissions: [] });
  const answer = canPort(noPermission, 'JS');
  assert.equal(answer.portable, false);
  assert.deepEqual(answer.reasons.map((entry) => entry.reason), ['missing-permission']);
  assert.match(answer.reasons[0].detail, /NETWORK:network/);
  const wrongCategory = mkNode('NETWORK', { requiredCapabilities: ['webhook.ingress'], requiredPermissions: ['storage:read'] });
  const categoryAnswer = canPort(wrongCategory, 'JS');
  assert.equal(categoryAnswer.portable, false, 'portability never re-labels authority');
  assert.ok(reasons(categoryAnswer).includes('missing-permission'));
});

test('NETWORK: runtime unsupported case — target-unsupported via node runtime requirements', () => {
  const node = mkNode('NETWORK', {
    requiredCapabilities: ['webhook.ingress'],
    requiredPermissions: ['webhook:receive'],
    portability: { class: 'NETWORK', runtimeRequirements: ['JS'] },
  });
  const answer = canPort(node, 'RUST_NATIVE');
  assert.equal(answer.portable, false);
  assert.ok(reasons(answer).includes('target-unsupported'));
  assert.equal(canPort(node, 'JS').overall, 'portable');
});

test('FILESYSTEM: permission present ports; permission missing refuses; environment mismatch refuses', () => {
  const base = { requiredCapabilities: ['storage.json-collections'], requiredPermissions: ['storage:read'] };
  const ok = mkNode('FILESYSTEM', base);
  assert.equal(canPort(ok, 'JS').overall, 'portable');
  const noPermission = mkNode('FILESYSTEM', { ...base, requiredPermissions: [] });
  assert.ok(reasons(canPort(noPermission, 'JS')).includes('missing-permission'));
  const envNode = mkNode('FILESYSTEM', {
    ...base,
    portability: { class: 'FILESYSTEM', environmentRequirements: { os: 'linux' } },
  });
  const mismatch = canPort(envNode, 'JS', { environment: { os: 'mac' } });
  assert.equal(mismatch.portable, false);
  assert.ok(reasons(mismatch).includes('environment-mismatch'));
  assert.equal(mismatch.reason, 'environment-incompatible');
  const absent = canPort(envNode, 'JS');
  assert.ok(reasons(absent).includes('environment-mismatch'), 'declared constraints with no context refuse');
  assert.equal(canPort(envNode, 'JS', { environment: { os: 'linux' } }).overall, 'portable');
  assert.equal(RUNTIME_MATRIX.FILESYSTEM.WASM.status, 'UNSUPPORTED', 'non-native target for filesystem class');
});

test('NATIVE_PROCESS: native target ports; local targets refuse; permission missing refuses', () => {
  const base = { requiredCapabilities: ['worker.orchestration'], requiredPermissions: ['worker:admin'] };
  for (const target of ['JS', 'RUST_NATIVE']) {
    assert.equal(canPort(mkNode('NATIVE_PROCESS', base), target).overall, 'portable', target);
  }
  const wasm = canPort(mkNode('NATIVE_PROCESS', base), 'WASM');
  assert.equal(wasm.portable, false);
  assert.ok(reasons(wasm).includes('target-unsupported'), 'wasm cell is UNSUPPORTED');
  assert.equal(wasm.reason, 'runtime-incompatible');
  const noPermission = mkNode('NATIVE_PROCESS', { ...base, requiredPermissions: [] });
  assert.ok(reasons(canPort(noPermission, 'JS')).includes('missing-permission'));
});

test('ENVIRONMENT_SPECIFIC: matching environment ports, mismatch refuses, declaration is mandatory', () => {
  const node = mkNode('ENVIRONMENT_SPECIFIC', {
    portability: { class: 'ENVIRONMENT_SPECIFIC', environmentRequirements: { region: 'eu' } },
  });
  assert.equal(canPort(node, 'JS', { environment: { region: 'eu' } }).overall, 'portable');
  const mismatch = canPort(node, 'JS', { environment: { region: 'us' } });
  assert.equal(mismatch.portable, false);
  assert.ok(reasons(mismatch).includes('environment-mismatch'));
  const undeclared = mkNode('ENVIRONMENT_SPECIFIC');
  const answer = canPort(undeclared, 'JS', { environment: { region: 'eu' } });
  assert.equal(answer.portable, false);
  assert.ok(reasons(answer).includes('missing-environment'));
  assert.equal(answer.reason, 'contract-incompatible');
});

test('REMOTE_BRIDGE: remote supported with authority; local-only refused; transport mismatch refused; authority missing refused', () => {
  const bridge = mkNode('REMOTE_BRIDGE', {
    requiredCapabilities: ['runtime.http-server'],
    requiredPermissions: ['lego:invoke'],
    portability: { class: 'REMOTE_BRIDGE', transport: 'ws-bridge' },
  });
  const ok = canPort(bridge, 'REMOTE', { transport: 'ws-bridge' });
  assert.equal(ok.overall, 'conditional');
  assert.equal(ok.portable, true);
  const local = canPort(bridge, 'JS');
  assert.equal(local.portable, false, 'local-only runtime');
  assert.ok(reasons(local).includes('target-unsupported'));
  const mismatch = canPort(bridge, 'REMOTE', { transport: 'http-rpc' });
  assert.equal(mismatch.portable, false);
  assert.ok(reasons(mismatch).includes('transport-mismatch'));
  const noAuthority = mkNode('REMOTE_BRIDGE', {
    requiredCapabilities: ['runtime.http-server'],
    requiredPermissions: [],
    portability: { class: 'REMOTE_BRIDGE', transport: 'ws-bridge' },
  });
  const authorityAnswer = canPort(noAuthority, 'REMOTE', { transport: 'ws-bridge' });
  assert.equal(authorityAnswer.portable, false);
  assert.ok(reasons(authorityAnswer).includes('missing-permission'));
  const noTransport = mkNode('REMOTE_BRIDGE', {
    requiredCapabilities: ['runtime.http-server'],
    requiredPermissions: ['lego:invoke'],
  });
  assert.ok(reasons(canPort(noTransport, 'REMOTE', { transport: 'ws-bridge' })).includes('declaration-conflict'),
    'class requires a declared transport');
});

/* ================================================================ *
 * §10 Compatibility classes: five axes, never one boolean
 * ================================================================ */

test('the compatibility report carries all five axes and the §10 class names', () => {
  assert.deepEqual([...COMPATIBILITY_AXES], ['contract', 'schema', 'runtime', 'portability', 'environment']);
  assert.deepEqual([...OVERALL_REASONS], [
    'contract-incompatible', 'schema-incompatible', 'runtime-incompatible',
    'portability-incompatible', 'environment-incompatible',
  ]);
  const answer = canPort(mkNode('PURE'), 'JS');
  for (const axis of COMPATIBILITY_AXES) {
    assert.equal(answer.compatibility[axis], 'compatible', axis);
  }
  assert.equal(answer.portable, true);
  assert.equal(answer.reason, null);
});

test('contract+schema compatible with an unsupported runtime yields overall=not-portable, reason=runtime-incompatible', () => {
  const node = mkNode('REMOTE_BRIDGE', {
    requiredCapabilities: ['runtime.http-server'],
    requiredPermissions: ['lego:invoke'],
    portability: { class: 'REMOTE_BRIDGE', transport: 'ws-bridge' },
  });
  const answer = canPort(node, 'JS');
  assert.equal(answer.compatibility.contract, 'compatible', 'declaration conforms');
  assert.equal(answer.compatibility.schema, 'compatible', 'subset holds');
  assert.equal(answer.compatibility.runtime, 'incompatible');
  assert.equal(answer.overall, 'not-portable');
  assert.equal(answer.reason, 'runtime-incompatible');
});

test('overall reason always derives from the FIRST failing axis in canonical order', () => {
  // contract fails (missing permission) AND environment would fail — contract wins the reason
  const node = mkNode('FILESYSTEM', { requiredCapabilities: ['storage.json-collections'], requiredPermissions: [] });
  const answer = canPort(node, 'JS');
  assert.equal(answer.compatibility.contract, 'incompatible');
  assert.equal(answer.reason, 'contract-incompatible');
  // schema fails while contract holds
  const schemaFail = mkNode('API', {
    requiredCapabilities: ['node-registry.catalog'],
    schemas: { input: { type: 'string', pattern: '^x' }, output: { type: 'boolean' } },
  });
  const schemaAnswer = canPort(schemaFail, 'JS');
  assert.equal(schemaAnswer.compatibility.contract, 'compatible');
  assert.equal(schemaAnswer.compatibility.schema, 'incompatible');
  assert.equal(schemaAnswer.reason, 'schema-incompatible');
});

/* ================================================================ *
 * §16 Fail-closed matrix — every unknown refuses, none assumes portable
 * ================================================================ */

test('unknown runtime / class / capability / permission each refuse with their own reason', () => {
  const node = mkNode('API', { requiredCapabilities: ['node-registry.catalog'] });
  const unknownRuntime = canPort(node, 'PY');
  assert.equal(unknownRuntime.portable, false);
  assert.ok(reasons(unknownRuntime).includes('unknown-runtime'));
  assert.equal(unknownRuntime.reason, 'runtime-incompatible');

  const unknownClass = mkNode('CLUSTERISH');
  const classAnswer = canPort(unknownClass, 'JS');
  assert.equal(classAnswer.portable, false);
  assert.ok(reasons(classAnswer).includes('unknown-portability-class'));

  const unknownCap = mkNode('API', { requiredCapabilities: ['node-registry.nope'] });
  assert.ok(reasons(canPort(unknownCap, 'JS')).includes('unknown-capability'));

  const unknownPerm = mkNode('API', {
    requiredCapabilities: ['node-registry.catalog'],
    requiredPermissions: ['node:portability:teleport'],
  });
  assert.ok(reasons(canPort(unknownPerm, 'JS')).includes('unknown-permission'));
});

test('every reason in every answer is a member of the closed set and maps to an axis', () => {
  assert.deepEqual([...PORTABILITY_REASONS].sort(), Object.keys(REASON_AXIS).sort(), 'reason ↔ axis tables agree');
  for (const axis of Object.values(REASON_AXIS)) assert.ok(COMPATIBILITY_AXES.includes(axis));
  const probes = [
    canPort(mkNode('PURE'), 'PY'),
    canPort(mkNode('CLUSTERISH'), 'JS'),
    canPort(mkNode('NETWORK', { requiredCapabilities: ['webhook.ingress'] }), 'JS'),
    canPort(mkNode('API', { requiredCapabilities: ['node-registry.catalog'], schemas: { input: { type: 'string', format: 'uri' }, output: { type: 'boolean' } } }), 'JS'),
    canPort(mkNode('ENVIRONMENT_SPECIFIC'), 'JS'),
  ];
  for (const answer of probes) {
    for (const entry of answer.reasons) {
      assert.ok(PORTABILITY_REASONS.includes(entry.reason), `${entry.reason} is closed-set`);
      assert.equal(entry.axis, REASON_AXIS[entry.reason]);
    }
    if (!answer.portable) assert.ok(OVERALL_REASONS.includes(answer.reason));
  }
});

test('a structurally invalid declaration throws NodePortabilityError (lego.contract_violation), never a guess', () => {
  assert.throws(() => validateNodeDeclaration(null), NodePortabilityError);
  assert.throws(() => validateNodeDeclaration({ nodeId: 'x' }), /missing required field/);
  assert.throws(() => validateNodeDeclaration(mkNode('PURE', { extra: { contract: 'NoDots' } })), /contract/);
  assert.throws(() => validateNodeDeclaration({
    ...mkNode('PURE'),
    requiredCapabilities: ['BAD CAP'],
  }), /requiredCapabilities/);
  assert.throws(() => validateNodeDeclaration({
    ...mkNode('PURE'),
    portability: { class: 'PURE', runtimeRequirements: ['JAVA'] },
  }), /runtimeRequirements/);
  try {
    validateNodeDeclaration({});
    assert.fail('must throw');
  } catch (error) {
    assert.equal(error.code, 'lego.contract_violation');
    assert.equal(error.name, 'NodePortabilityError');
  }
});

/* ================================================================ *
 * §11 Runtime selection policy — facts and policy, no language favorite
 * ================================================================ */

test('the selection policy names the six criteria and never a language preference', () => {
  assert.deepEqual([...RUNTIME_SELECTION_POLICY], [
    'security', 'performance', 'portability', 'compatibility',
    'capability-requirements', 'environment-constraints',
  ]);
  const text = RUNTIME_SELECTION_POLICY.join(' ').toLowerCase();
  assert.ok(!text.includes('rust') && !text.includes('javascript') && !text.includes('wasm'));
  assert.ok(!/rust (is|always)|always.*rust/i.test(MODULE_SOURCE));
  assert.ok(!/javascript (is|always)|always.*javascript/i.test(MODULE_SOURCE));
});

test('selection filters by canPort, orders SUPPORTED before CONDITIONAL, and reports every rejection', () => {
  const bridge = mkNode('REMOTE_BRIDGE', {
    requiredCapabilities: ['runtime.http-server'],
    requiredPermissions: ['lego:invoke'],
    portability: { class: 'REMOTE_BRIDGE', transport: 'ws-bridge' },
  });
  const selection = selectRuntime(bridge, { transport: 'ws-bridge' });
  assert.equal(selection.selected.target, 'REMOTE');
  assert.equal(selection.selected.overall, 'conditional');
  assert.deepEqual(selection.rejected.map((entry) => entry.target), ['JS', 'WASM', 'RUST_NATIVE']);
  for (const entry of selection.rejected) assert.ok(OVERALL_REASONS.includes(entry.reason));
  assert.deepEqual([...selection.policy], [...RUNTIME_SELECTION_POLICY]);

  const pure = selectRuntime(mkNode('PURE'), {});
  assert.equal(pure.selected.target, 'JS', 'SUPPORTED cells first, canonical enumeration as documented tie-break');
  assert.equal(pure.candidates.length, 3, 'REMOTE is conditional and the empty context carries no transport');
  assert.ok(pure.rejected.some((entry) => entry.target === 'REMOTE' && entry.reasons.some((r) => r.reason === 'transport-mismatch')));
  assert.equal(pure.candidates[0].matrixStatus, 'SUPPORTED');
  const routed = selectRuntime(mkNode('PURE'), { transport: 'ws-bridge' });
  assert.equal(routed.candidates.length, 4, 'with a transport context all four targets are candidates');
});

test('a declared performance ranking moves the pick without changing the filters (no hardcoded winner)', () => {
  const pure = mkNode('PURE');
  const defaultPick = selectRuntime(pure, {});
  assert.equal(defaultPick.selected.target, 'JS');
  const ranked = selectRuntime(pure, { performanceRank: ['RUST_NATIVE', 'WASM', 'JS', 'REMOTE'] });
  assert.equal(ranked.selected.target, 'RUST_NATIVE', 'performance rank decides among SUPPORTED cells');
  const network = mkNode('NETWORK', {
    requiredCapabilities: ['webhook.ingress'],
    requiredPermissions: ['webhook:receive'],
  });
  const networkRanked = selectRuntime(network, { performanceRank: ['RUST_NATIVE', 'JS', 'WASM', 'REMOTE'] });
  assert.equal(networkRanked.selected.target, 'RUST_NATIVE');
  const hostless = selectRuntime(network, {});
  // WASM for NETWORK is conditional on capability-host — without the host it is rejected, not silently picked
  assert.ok(hostless.rejected.some((entry) => entry.target === 'WASM'));
});

test('security profile mismatch refuses instead of downgrading the requirement', () => {
  const node = mkNode('API', {
    requiredCapabilities: ['node-registry.catalog'],
    extra: { securityProfile: 'strict' },
  });
  const match = canPort(node, 'JS', { requireSecurityProfile: 'strict' });
  assert.equal(match.overall, 'portable');
  const mismatch = canPort(node, 'JS', { requireSecurityProfile: 'hardened' });
  assert.equal(mismatch.portable, false);
  assert.ok(reasons(mismatch).includes('security-mismatch'));
  assert.equal(mismatch.reason, 'environment-incompatible');
});

/* ================================================================ *
 * §13/§14 Portability grants nothing
 * ================================================================ */

test('canPort returns classification only — no authority fields anywhere in the answer', () => {
  const answer = canPort(mkNode('NETWORK', {
    requiredCapabilities: ['webhook.ingress'],
    requiredPermissions: ['webhook:receive'],
  }), 'JS');
  assert.deepEqual(Object.keys(answer).sort(), [
    'class', 'compatibility', 'matrixStatus', 'overall', 'portable',
    'reason', 'reasons', 'target',
  ]);
  const text = JSON.stringify(answer);
  for (const word of ['granted', 'authorized', 'allowToken', 'credential', 'approval']) {
    assert.ok(!text.includes(word), `answer never carries '${word}'`);
  }
});

test('PURE refuses declarations of network/filesystem/process/environment authority (§14)', () => {
  const withPermission = canPort(mkNode('PURE', { requiredPermissions: ['webhook:receive'] }), 'JS');
  assert.equal(withPermission.portable, false);
  assert.ok(reasons(withPermission).includes('declaration-conflict'));
  const withCapability = canPort(mkNode('PURE', { requiredCapabilities: ['storage.json-collections'] }), 'JS');
  assert.ok(reasons(withCapability).includes('declaration-conflict'));
  const withEnvironment = canPort(mkNode('PURE', {
    portability: { class: 'PURE', environmentRequirements: { os: 'linux' } },
  }), 'JS');
  assert.ok(reasons(withEnvironment).includes('declaration-conflict'));
  const withTransport = canPort(mkNode('PURE', {
    portability: { class: 'PURE', transport: 'ws-bridge' },
  }), 'JS');
  assert.ok(reasons(withTransport).includes('declaration-conflict'));
});

test('permission categories are closed and every class rule names only canonical fields', () => {
  assert.deepEqual(Object.keys(PERMISSION_CATEGORIES).sort(), ['filesystem', 'network', 'process', 'remote']);
  for (const [category, prefixes] of Object.entries(PERMISSION_CATEGORIES)) {
    assert.ok(Array.isArray(prefixes) && prefixes.length > 0, category);
    for (const prefix of prefixes) assert.equal(typeof prefix, 'string');
  }
  for (const [cls, rules] of Object.entries(CLASS_DECLARATION_RULES)) {
    assert.ok(PORTABILITY_CLASSES.includes(cls), 'rules only for canonical classes');
    if (rules.requirePermissionCategory) assert.ok(PERMISSION_CATEGORIES[rules.requirePermissionCategory]);
    for (const key of ['allowCapabilities', 'allowPermissions', 'allowEnvironment', 'allowTransport',
      'requireCapabilities', 'requireEnvironment', 'requireTransport']) {
      assert.equal(typeof rules[key], 'boolean', `${cls}.${key}`);
    }
    assert.ok(rules.note.length > 10, `${cls} explains itself`);
  }
});

/* ================================================================ *
 * §21/§9 Round-trip matrix: declared portable passes, declared not fails
 * ================================================================ */

test('every SUPPORTED class × target round-trips the fixture schemas', () => {
  const { input, output } = portableSchemas();
  for (const cls of PORTABILITY_CLASSES) {
    for (const target of PORTABILITY_TARGETS) {
      const cell = RUNTIME_MATRIX[cls][target];
      if (cell.status === 'UNSUPPORTED') {
        const node = mkNode(cls, cls === 'REMOTE_BRIDGE'
          ? { requiredCapabilities: ['runtime.http-server'], requiredPermissions: ['lego:invoke'], portability: { class: cls, transport: 'ws-bridge' } }
          : {});
        const answer = canPort(node, target, { transport: 'ws-bridge', environment: {}, hostCapabilities: [...node.requiredCapabilities] });
        assert.equal(answer.portable, false, `${cls}/${target} is declared not-portable and refuses`);
        continue;
      }
      if (cls === 'PURE') {
        const reportInput = roundTrip(input, target);
        assert.equal(reportInput.equal, true, `${cls}/${target} input`);
        assert.equal(roundTrip(output, target).equal, true, `${cls}/${target} output`);
      }
    }
  }
});

test('declared-unportable features fail deterministically with the same reason every run', () => {
  const schema = { type: 'string', pattern: '\\d+' };
  const first = roundTrip(schema, 'JS');
  const second = roundTrip(schema, 'JS');
  assert.deepEqual(first, second);
  assert.equal(first.reason, 'schema-unsupported');
  const lossyFirst = roundTrip({ type: 'string', format: 'email' }, 'RUST_NATIVE');
  const lossySecond = roundTrip({ type: 'string', format: 'email' }, 'RUST_NATIVE');
  assert.deepEqual(lossyFirst, lossySecond);
  assert.equal(lossyFirst.reason, 'schema-lossy');
});

/* ================================================================ *
 * §22 Differential testing on declared facets
 * ================================================================ */

test('the canonical fixtures declare equivalence across JS, WASM and Rust — on the five facets only', () => {
  assert.deepEqual([...DIFFERENTIAL_FACETS], [
    'input', 'outputSchema', 'errors', 'artifactMetadata', 'sideEffectDeclaration',
  ]);
  assert.deepEqual(CANONICAL_FIXTURES.map((entry) => entry.target), ['JS', 'WASM', 'RUST_NATIVE']);
  const report = compareImplementations([...CANONICAL_FIXTURES]);
  assert.equal(report.equivalent, true, JSON.stringify(report.mismatches));
  assert.deepEqual([...report.facets], [...DIFFERENTIAL_FACETS]);
});

test('a facet mismatch is reported by facet and target pair — hidden details are never compared', () => {
  const mutated = CANONICAL_FIXTURES.map((entry, index) => (index === 1
    ? { target: entry.target, fixture: { ...entry.fixture, sideEffectDeclaration: ['writes-tmp'] } }
    : entry));
  const report = compareImplementations([...mutated]);
  assert.equal(report.equivalent, false);
  assert.equal(report.mismatches.length, 1);
  assert.equal(report.mismatches[0].facet, 'sideEffectDeclaration');
  assert.deepEqual([...report.mismatches[0].targets], ['JS', 'WASM']);
  // fewer than two implementations is a contract error, not a vacuous pass
  assert.throws(() => compareImplementations([CANONICAL_FIXTURES[0]]), NodePortabilityError);
});

/* ================================================================ *
 * §7 Read path + determinism
 * ================================================================ */

test('describePortability reports the declaration without deciding anything', () => {
  const node = mkNode('NETWORK', {
    requiredCapabilities: ['webhook.ingress'],
    requiredPermissions: ['webhook:receive'],
    portability: { class: 'NETWORK', environmentRequirements: { region: 'eu' } },
    extra: { artifactRequirements: ['art-portability-report'], securityProfile: 'strict' },
  });
  const view = describePortability(node);
  assert.equal(view.class, 'NETWORK');
  assert.equal(view.matrixRow.WASM, 'CONDITIONAL');
  assert.equal(view.transport, null);
  assert.deepEqual([...view.environment], ['region']);
  assert.equal(view.securityProfile, 'strict');
  assert.deepEqual([...view.artifactRequirements], ['art-portability-report']);
  assert.deepEqual(view.schemaFeatures, [...new Set([...view.schemaFeatures])].sort());
  for (const key of ['portable', 'selected', 'granted', 'eligible']) {
    assert.ok(!(key in view), 'the read path never answers an eligibility question');
  }
});

test('canPort is a pure function: same inputs, byte-identical answer, no clock, no randomness', () => {
  const node = mkNode('API', { requiredCapabilities: ['node-registry.catalog'] });
  const first = canPort(node, 'JS', { environment: { region: 'eu' } });
  const second = canPort(node, 'JS', { environment: { region: 'eu' } });
  assert.deepEqual(first, second);
  assert.ok(!/Math\.random|new Date\(|setTimeout|performance\.now/.test(MODULE_SOURCE),
    'no wall clock, timers or randomness in the module');
});

/* ================================================================ *
 * §31 Static walls: imports, forbidden implementations, boot
 * ================================================================ */

test('the module imports exactly one backend file (the domain registry) — no fs/net/process/timers/model', () => {
  const imports = [...MODULE_SOURCE.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./registry.mjs'], 'static imports are the registry and nothing else');
  for (const forbidden of ['node:fs', 'node:net', 'node:child_process', 'node:timers', 'node:http',
    'node:https', 'node:worker_threads', 'fetch(', 'undici', 'child_process']) {
    assert.ok(!MODULE_SOURCE.includes(forbidden), `forbidden import/usage: ${forbidden}`);
  }
  for (const forbidden of ['mcp', 'Mcp', 'model-gateway', 'inference', 'approval.mjs', 'audit.mjs', 'transport-kernel']) {
    assert.ok(!imports.includes(forbidden), `no ${forbidden} import`);
  }
});

test('no Node Creator, no translation engine, no provider integration leaks into exports or source', () => {
  for (const name of Object.keys(portability)) {
    assert.ok(!/translat|creator|nodeCreate|publish|generateNode/i.test(name), `${name} stays out of scope`);
  }
  for (const provider of ['Composio', '9router', 'Hermes', 'DeepSeek', 'MiroFish', 'OpenClaw',
    'Claude', 'Gemini', 'Antigravity', 'GitHub provider']) {
    assert.ok(!MODULE_SOURCE.includes(provider), `no ${provider} integration`);
  }
  assert.ok(!/createNode\s*\(|generateNode\s*\(|class NodeCreator/.test(MODULE_SOURCE));
  assert.ok(!/translateSchema|translation engine/i.test(MODULE_SOURCE.replace(/no translation engine/g, '')),
    'translation belongs to P2.23');
});

test('the module touches neither agent machine internals nor the boot-facing frontend manifests', () => {
  assert.ok(!MODULE_SOURCE.includes('agent-machine'), 'P2.22 does not reach into P2.16 internals');
  assert.ok(!MODULE_SOURCE.includes('capabilities.json'), 'portability metadata never enters the boot payload path');
  // agent-machine export surface remains exactly 23 — read, not modified
  const agentSource = readFileSync(join(HERE.pathname, '..', 'src', 'lego', 'agent-machine.mjs'), 'utf8');
  assert.equal((agentSource.match(/^export /gm) ?? []).length, 23, 'P2.16 export surface untouched');
});
