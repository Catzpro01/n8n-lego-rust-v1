/**
 * P2.27.2 — plugin manifest + registry + contract resolution.
 *
 * Proves the fail-closed manifest schema (unknown fields, bad grammar,
 * unbounded arrays all reject), the single-active-version identity rules
 * (duplicate ids reject with the published contract_violation code),
 * `compat.mjs` range semantics consumed verbatim (0.x caret = same minor),
 * honest events into the core ring, and the runtime↔registry wiring.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_MANIFEST_REQUIRED,
  PLUGIN_MANIFEST_OPTIONAL,
  PLUGIN_RESOURCE_LIMIT_FIELDS,
  PLUGIN_MANIFEST_BOUNDS,
  validateManifest,
} from '../src/lego/plugin-manifest.mjs';
import { createPluginRegistry } from '../src/lego/plugin-registry.mjs';
import { createPluginRuntime, bootstrapPluginCore, PluginRuntimeError } from '../src/lego/plugin-runtime.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));

const baseManifest = (overrides = {}) => ({
  id: 'pdf-exporter',
  version: '1.4.0',
  publisher: 'acme',
  contract: { id: 'acme.pdf', range: '^1.0.0' },
  trustClass: 'TRUSTED',
  runtimeClass: 'IN_PROCESS',
  requestedCapabilities: ['network'],
  ...overrides,
});

const violationWith = (fn, fragment) =>
  assert.throws(
    fn,
    (error) =>
      error instanceof PluginRuntimeError &&
      error.code === 'lego.contract_violation' &&
      (fragment === undefined || error.message.includes(fragment)),
    `expected contract_violation mentioning '${fragment}'`,
  );

/* ------------------------------------------------------------ manifest schema */

test('the required/optional field lists are the design §5 surface', () => {
  assert.deepEqual(
    [...PLUGIN_MANIFEST_REQUIRED],
    ['id', 'version', 'publisher', 'contract', 'trustClass', 'runtimeClass', 'requestedCapabilities'],
  );
  assert.deepEqual(
    [...PLUGIN_MANIFEST_OPTIONAL],
    ['resourceLimits', 'dependencies', 'digest', 'signature', 'provenance', 'sbom'],
  );
  assert.ok(PLUGIN_RESOURCE_LIMIT_FIELDS.includes('queueDepth'));
  assert.ok(PLUGIN_RESOURCE_LIMIT_FIELDS.includes('timeoutMs'));
  assert.equal(PLUGIN_MANIFEST_BOUNDS.capabilitiesMax, 32);
  assert.equal(PLUGIN_MANIFEST_BOUNDS.dependenciesMax, 64);
});

test('a minimal valid manifest validates, normalizes, freezes and never mutates the input', () => {
  const input = baseManifest();
  const frozen = validateManifest(input);
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.contract));
  assert.ok(Object.isFrozen(frozen.requestedCapabilities));
  assert.equal(frozen.id, 'pdf-exporter');
  assert.deepEqual(input.requestedCapabilities, ['network'], 'input untouched');
  // optional fields pass through when well-formed
  const rich = validateManifest(
    baseManifest({
      resourceLimits: { concurrency: 4, queueDepth: 128, timeoutMs: 30_000 },
      dependencies: [{ id: 'acme.codec', range: '~2.1.0' }],
      digest: `sha256:${'a'.repeat(64)}`,
      signature: 'sig-bytes',
      provenance: 'https://example.invalid/provenance',
      sbom: 'spdx:demo',
    }),
  );
  assert.ok(Object.isFrozen(rich.resourceLimits));
  assert.equal(rich.dependencies.length, 1);
});

test('every required field is enforced — missing any one is a contract violation', () => {
  for (const field of PLUGIN_MANIFEST_REQUIRED) {
    const manifest = baseManifest();
    delete manifest[field];
    violationWith(() => validateManifest(manifest), field);
  }
  violationWith(() => validateManifest(null), 'plain object');
  violationWith(() => validateManifest([]), 'plain object');
});

test('identity rules: id must be kebab-case, version must be major.minor.patch', () => {
  for (const badId of ['A', 'x', 'has.dot', 'has_underscore', '', '-lead', `${'x'.repeat(65)}`]) {
    violationWith(() => validateManifest(baseManifest({ id: badId })), undefined);
  }
  for (const badVersion of ['1.2', 'v1.2.3', '1.2.3.4', 'latest', '']) {
    violationWith(() => validateManifest(baseManifest({ version: badVersion })), undefined);
  }
  assert.equal(validateManifest(baseManifest({ id: 'memory-rust' })).id, 'memory-rust');
});

test('trust and runtime classes accept ONLY the canonical four-by-four vocabularies', () => {
  violationWith(() => validateManifest(baseManifest({ trustClass: 'trusted' })), 'trustClass');
  violationWith(() => validateManifest(baseManifest({ trustClass: 'VERIFIED' })), 'trustClass');
  violationWith(() => validateManifest(baseManifest({ trustClass: 'HIGH' })), 'trustClass');
  violationWith(() => validateManifest(baseManifest({ runtimeClass: 'in-process' })), 'runtimeClass');
  violationWith(() => validateManifest(baseManifest({ runtimeClass: 'LOCAL' })), 'runtimeClass');
  violationWith(() => validateManifest(baseManifest({ runtimeClass: 'PROCESS' })), 'runtimeClass');
  for (const trustClass of ['CORE', 'TRUSTED', 'ISOLATED', 'SANDBOXED']) {
    assert.equal(validateManifest(baseManifest({ trustClass })).trustClass, trustClass);
  }
  for (const runtimeClass of ['IN_PROCESS', 'WASM', 'ISOLATED_PROCESS', 'REMOTE']) {
    assert.equal(validateManifest(baseManifest({ runtimeClass })).runtimeClass, runtimeClass);
  }
});

test('capabilities are bounded, patterned and duplicate-free', () => {
  violationWith(() => validateManifest(baseManifest({ requestedCapabilities: 'network' })), 'array');
  violationWith(() => validateManifest(baseManifest({ requestedCapabilities: [1] })), 'malformed');
  violationWith(() => validateManifest(baseManifest({ requestedCapabilities: ['NETWORK'] })), 'malformed');
  violationWith(
    () => validateManifest(baseManifest({ requestedCapabilities: ['network', 'network'] })),
    'repeats',
  );
  const tooMany = Array.from({ length: PLUGIN_MANIFEST_BOUNDS.capabilitiesMax + 1 }, (_, i) => `cap${i}`);
  violationWith(() => validateManifest(baseManifest({ requestedCapabilities: tooMany })), 'exceeds');
  const ok = validateManifest(baseManifest({ requestedCapabilities: ['network', 'memory.read', 'fs.write'] }));
  assert.deepEqual([...ok.requestedCapabilities], ['network', 'memory.read', 'fs.write']);
});

test('range grammar is compat.mjs grammar or it is rejected', () => {
  for (const range of ['*', '1.4.0', '^1.2.3', '~2.1.0', '>=1.0.0']) {
    assert.ok(validateManifest(baseManifest({ contract: { id: 'acme.pdf', range } })).contract.range === range);
  }
  for (const badRange of ['<2.0.0', '>=1.0.0 <2.0.0', '^1.2.3 || ^2.0.0', 'x', '']) {
    violationWith(() => validateManifest(baseManifest({ contract: { id: 'acme.pdf', range: badRange } })), 'range');
  }
  violationWith(() => validateManifest(baseManifest({ contract: { id: 'bad id', range: '^1.0.0' } })), 'contract.id');
  violationWith(() => validateManifest(baseManifest({ contract: { id: 'acme.pdf' } })), '{ id, range }');
});

test('unknown top-level fields fail closed — a hostile field cannot ride along', () => {
  violationWith(() => validateManifest(baseManifest({ hotSwapper: true })), 'unknown field');
  violationWith(() => validateManifest(baseManifest({ permissions: ['*'] })), 'unknown field');
  violationWith(() => validateManifest(baseManifest({ capabilities: { network: true } })), 'unknown field');
});

test('resource limits: known bounded integers only', () => {
  violationWith(() => validateManifest(baseManifest({ resourceLimits: { ram: 'unlimited' } })), 'unknown field');
  violationWith(() => validateManifest(baseManifest({ resourceLimits: { queueDepth: -1 } })), 'integer');
  violationWith(
    () => validateManifest(baseManifest({ resourceLimits: { timeoutMs: PLUGIN_MANIFEST_BOUNDS.resourceValueMax + 1 } })),
    'integer',
  );
  violationWith(() => validateManifest(baseManifest({ resourceLimits: { concurrency: 2.5 } })), 'integer');
  violationWith(() => validateManifest(baseManifest({ resourceLimits: [] })), 'plain object');
});

test('dependencies are bounded contract refs with unique ids', () => {
  violationWith(
    () => validateManifest(baseManifest({ dependencies: [{ id: 'acme.codec', range: '^1.0.0' }, { id: 'acme.codec', range: '^2.0.0' }] })),
    'repeats dependency',
  );
  violationWith(() => validateManifest(baseManifest({ dependencies: [{ id: 'acme.codec', range: '<2' }] })), 'range');
  violationWith(() => validateManifest(baseManifest({ dependencies: [{ id: 'nodot', range: '^1.0.0' }] })), 'dependencies[0].id');
  const tooMany = Array.from({ length: PLUGIN_MANIFEST_BOUNDS.dependenciesMax + 1 }, (_, i) => ({
    id: `acme.dep${i}`,
    range: '^1.0.0',
  }));
  violationWith(() => validateManifest(baseManifest({ dependencies: tooMany })), 'exceeds');
});

test('supply-chain blobs only accept their declared shapes', () => {
  violationWith(() => validateManifest(baseManifest({ digest: 'sha1:zzzz' })), 'digest');
  violationWith(() => validateManifest(baseManifest({ digest: `sha256:${'A'.repeat(64)}` })), 'digest');
  violationWith(() => validateManifest(baseManifest({ signature: '' })), 'signature');
});

/* ------------------------------------------------------------ registry */

test('register validates, freezes a DISCOVERED record and emits plugin.registered', () => {
  const seen = [];
  let t = 500;
  const registry = createPluginRegistry({ now: () => (t += 10), onEvent: (type, detail) => seen.push({ type, detail }) });
  const record = registry.register(baseManifest(), { operations: {} });
  assert.equal(record.state, 'DISCOVERED');
  assert.equal(record.registeredAt, 510);
  assert.ok(Object.isFrozen(record));
  assert.equal(registry.size(), 1);
  assert.equal(registry.has('pdf-exporter'), true);
  assert.deepEqual(seen, [
    { type: 'plugin.registered', detail: { id: 'pdf-exporter', version: '1.4.0', trustClass: 'TRUSTED', runtimeClass: 'IN_PROCESS' } },
  ]);
  const [summary] = registry.list();
  assert.equal(summary.publisher, 'acme');
  assert.equal('implementation' in summary, false, 'list() never leaks the implementation');
});

test('duplicate ids fail closed with contract_violation and a rejected event', () => {
  const seen = [];
  const registry = createPluginRegistry({ onEvent: (type, detail) => seen.push({ type, detail }) });
  registry.register(baseManifest(), {});
  violationWith(() => registry.register(baseManifest({ version: '2.0.0' }), {}), 'already registered');
  assert.equal(registry.size(), 1, 'the duplicate never partially registers');
  const rejected = seen.filter((event) => event.type === 'plugin.rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].detail.phase, 'duplicate');
  assert.equal(rejected[0].detail.code, 'lego.contract_violation');
});

test('invalid manifests and missing implementations reject without partial state', () => {
  const seen = [];
  const registry = createPluginRegistry({ onEvent: (type, detail) => seen.push({ type, detail }) });
  violationWith(() => registry.register(baseManifest({ id: 'Bad Id' }), {}), undefined);
  violationWith(() => registry.register(baseManifest(), null), 'no implementation');
  violationWith(() => registry.register(baseManifest(), undefined), 'no implementation');
  assert.equal(registry.size(), 0, 'failed registrations leave no residue');
  assert.equal(seen.filter((event) => event.type === 'plugin.rejected').length, 3);
});

test('resolveContract uses compat satisfies: providers, 0.x minors and honest failure codes', () => {
  const registry = createPluginRegistry();
  registry.register(baseManifest({ id: 'pdf-v1', version: '1.4.0', contract: { id: 'acme.pdf', range: '^1.0.0' } }), {});
  registry.register(baseManifest({ id: 'pdf-v2', version: '2.0.0', contract: { id: 'acme.pdf', range: '^2.0.0' } }), {});
  registry.register(
    baseManifest({ id: 'prov-03', version: '0.3.1', contract: { id: 'acme.provisional', range: '~0.3.0' } }),
    {},
  );

  assert.equal(registry.resolveContract('acme.pdf', '^1.0.0').id, 'pdf-v1');
  assert.equal(registry.resolveContract('acme.pdf', '2.0.0').id, 'pdf-v2');
  assert.equal(registry.resolveContract('acme.pdf', '*').version, '1.4.0', '* takes the first provider in insertion order');

  assert.throws(
    () => registry.resolveContract('acme.pdf', '^3.0.0'),
    (error) =>
      error.code === 'lego.version_incompatible' &&
      Array.isArray(error.details.available) &&
      error.details.available.includes('1.4.0'),
  );
  assert.throws(
    () => registry.resolveContract('acme.missing', '*'),
    (error) => error.code === 'lego.unavailable' && error.details.contractId === 'acme.missing',
  );
  // 0.x caret does NOT accept a higher minor — compat.mjs semantics consumed as-is
  assert.throws(
    () => registry.resolveContract('acme.provisional', '^0.2.0'),
    (error) => error.code === 'lego.version_incompatible',
  );
  assert.equal(registry.resolveContract('acme.provisional', '^0.3.0').id, 'prov-03');
});

test('unregister drains a record, emits plugin.deactivated and answers honestly for unknown ids', () => {
  const seen = [];
  const registry = createPluginRegistry({ onEvent: (type, detail) => seen.push({ type, detail }) });
  registry.register(baseManifest(), {});
  assert.equal(registry.unregister('pdf-exporter'), true);
  assert.equal(registry.unregister('pdf-exporter'), false);
  assert.equal(registry.size(), 0);
  assert.deepEqual(
    seen.filter((event) => event.type === 'plugin.deactivated'),
    [{ type: 'plugin.deactivated', detail: { id: 'pdf-exporter', reason: 'unregistered' } }],
  );
});

test('registry options themselves fail closed', () => {
  assert.throws(() => createPluginRegistry({ now: 1 }), TypeError);
  assert.throws(() => createPluginRegistry({ onEvent: 'nope' }), TypeError);
});

/* ------------------------------------------------------------ runtime wiring */

test('an injected registry flows through the core and health().plugins counts it', () => {
  const registry = createPluginRegistry();
  const runtime = createPluginRuntime({ registry });
  assert.equal(runtime.registry, registry);
  assert.equal(runtime.health().plugins, 0);
  registry.register(baseManifest(), {});
  assert.equal(runtime.health().plugins, 1);
  const booted = bootstrapPluginCore({ registry });
  assert.equal(booted.health().plugins, 1);
});

test('a non-registry object is refused at construction', () => {
  assert.throws(() => createPluginRuntime({ registry: {} }), TypeError);
  assert.throws(() => createPluginRuntime({ registry: { size: 3, get: null } }), TypeError);
});

/* ------------------------------------------------------------ lock row drift */

test('the lego.plugin-runtime row keeps the P2.27.2 modules locked (exact surface pins live in the newest slice suite)', () => {
  const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));
  const row = lock.contracts.find((entry) => entry.id === 'lego.plugin-runtime');
  assert.ok(row);
  assert.match(row.version, /^\d+\.\d+\.\d+$/);
  for (const file of ['src/lego/plugin-manifest.mjs', 'src/lego/plugin-registry.mjs', 'src/lego/plugin-runtime.mjs']) {
    assert.ok(row.surface.includes(file), `${file} stays on the surface`);
  }
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-registry.test.mjs'));
  assert.ok(row.tests.includes('apps/n8n-lego/test/lego-plugin-runtime.test.mjs'));
  for (const file of row.surface) {
    const source = readFileSync(join(APP_ROOT, file), 'utf8');
    const exported = [...source.matchAll(/^export (?:const|class|function) (\w+)/gm)].map((match) => match[1]).sort();
    const locked = [...(row.exports[file] ?? [])].sort();
    assert.deepEqual(locked, exported, `lock ⇄ module exports for ${file}`);
  }
});
