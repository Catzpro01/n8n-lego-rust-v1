/**
 * P6.25 — the native ABI and dual artifacts.
 * Contract `node.abi@0.1.0`.
 *
 * Matrix: declaring implementations (kinds, localities that the kind decides, ABI versions,
 * digests), vectors derived from the wire contract, conformance where a missing case is
 * INCOMPLETE and a disagreement is DIVERGENT, the dual rule (two implementations that disagree
 * are two nodes sharing a name), selection with a declared substitution, the reads, and the walls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { NODE_RUNTIME_LOCALITIES } from '../src/lego/node-registry.mjs';
import {
  ABI_CONTRACT,
  ABI_CONTRACT_VERSION,
  ABI_OPERATIONS,
  ABI_PERMISSIONS,
  ABI_REASONS,
  ABI_REQUIRED_KINDS,
  ABI_RULES,
  ABI_SCHEMA_VERSION,
  ABI_TYPES,
  AbiError,
  CONFORMANCE_VERDICTS,
  IMPLEMENTATION_KINDS,
  LOCALITY_BY_KIND,
  NATIVE_ABI_VERSION,
  VECTOR_KINDS,
  abiDigest,
  compareConformance,
  conformDualArtifact,
  conformanceVectors,
  declareDualArtifact,
  describeDualArtifact,
  explainConformance,
  isConformanceReport,
  isConformanceVectors,
  isDualArtifact,
  selectImplementation,
  stableJson,
} from '../src/lego/native-abi.mjs';

/* ------------------------------------------------------------------ fixtures */

const WIRE = 'a'.repeat(64);
const SEMANTICS = 'b'.repeat(64);

const JS_IMPL = { kind: 'js', artifact: 'dist/set.js', digest: `sha256:${'1'.repeat(64)}` };
const NATIVE_IMPL = { kind: 'native', artifact: 'libset.so', digest: `sha256:${'2'.repeat(64)}`, abiVersion: NATIVE_ABI_VERSION };

const DUAL = (overrides = {}) => declareDualArtifact({
  identity: 'n8n-nodes-base.set@3.4',
  ioDigest: WIRE,
  semanticsDigest: SEMANTICS,
  implementations: [JS_IMPL, NATIVE_IMPL],
  ...overrides,
});

const VECTORS = (overrides = {}) => conformanceVectors({
  identity: 'n8n-nodes-base.set@3.4',
  ioDigest: WIRE,
  fields: { id: 'string', count: 'number' },
  additionalProperties: false,
  ...overrides,
});

const ALL_OK = { 'empty-item': 'ok', 'full-item': 'ok', 'unexpected-field': 'refused', 'null-field': 'ok' };

const throwsWith = (fn, code) => {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof AbiError, `expected an AbiError carrying ${code}`);
  assert.equal(caught.code, 'lego.contract_violation');
  assert.equal(caught.meta.code, code);
  return caught;
};

/* ------------------------------------------------------------------ contract */

test('the contract surface is the published one: id, version, ops, closed vocabularies', () => {
  assert.equal(ABI_CONTRACT, 'node.abi@0.1.0');
  assert.equal(ABI_CONTRACT_VERSION, '0.1.0');
  assert.equal(ABI_SCHEMA_VERSION, 1);
  assert.deepEqual([...ABI_OPERATIONS], ['declare', 'vectors', 'conform', 'select', 'describe']);
  assert.deepEqual([...ABI_PERMISSIONS], ['node:read']);
  assert.deepEqual([...IMPLEMENTATION_KINDS], ['js', 'native', 'wasm']);
  assert.deepEqual({ ...LOCALITY_BY_KIND }, { js: 'js-compat', native: 'rust-native', wasm: 'wasm' });
  assert.deepEqual([...ABI_REQUIRED_KINDS], ['native', 'wasm']);
  assert.deepEqual([...CONFORMANCE_VERDICTS], ['MATCH', 'DIVERGENT', 'INCOMPLETE']);
  assert.deepEqual([...VECTOR_KINDS], ['empty-item', 'full-item', 'unexpected-field', 'null-field']);
  assert.equal(ABI_TYPES.includes('bytes-handle'), true);
  assert.equal(ABI_TYPES.includes('pointer'), false, 'a pointer crossing the boundary would make the language part of the contract');
  assert.equal(NATIVE_ABI_VERSION, 'lego-native-abi@1');
  assert.equal(ABI_REASONS.length, 6);
  assert.match(ABI_RULES.agree, /two implementations that disagree are two nodes sharing a name/);
  assert.deepEqual([...NODE_RUNTIME_LOCALITIES], ['js-compat', 'remote-worker', 'rust-native', 'wasm']);
});

test('an implementation kind decides its locality, and a native artifact declares the ABI it was built against', () => {
  const artifact = DUAL();
  assert.equal(isDualArtifact(artifact), true);
  assert.equal(artifact.dual, true);
  assert.deepEqual([...artifact.kinds], ['js', 'native']);
  assert.deepEqual(artifact.implementations.map((implementation) => implementation.locality), ['js-compat', 'rust-native']);
  assert.equal(artifact.implementations[0].abiVersion, null, 'the host language claiming an ABI would be a costume');
  assert.equal(artifact.implementations[1].abiVersion, NATIVE_ABI_VERSION);
  assert.match(artifact.artifactDigest, /^[0-9a-f]{64}$/);
  const { artifactDigest, ...body } = artifact;
  assert.equal(artifactDigest, abiDigest(body));

  const single = DUAL({ implementations: [JS_IMPL] });
  assert.equal(single.dual, false);
  throwsWith(() => DUAL({ identity: 'n8n-nodes-base.set' }), 'abi.input');
  throwsWith(() => DUAL({ ioDigest: '' }), 'abi.artifact');
  throwsWith(() => DUAL({ implementations: [] }), 'abi.artifact');
  throwsWith(() => DUAL({ implementations: [{ kind: 'cpp', digest: 'x' }] }), 'abi.artifact');
  throwsWith(() => DUAL({ implementations: [JS_IMPL, JS_IMPL] }), 'abi.artifact');
  assert.match(
    throwsWith(() => DUAL({ implementations: [JS_IMPL, { ...NATIVE_IMPL, locality: 'wasm' }] }), 'abi.locality').message,
    /the kind decides where it runs/,
  );
  assert.match(
    throwsWith(() => DUAL({ implementations: [JS_IMPL, { kind: 'native', digest: 'sha256:x' }] }), 'abi.artifact').message,
    /must declare the ABI it was built against/,
  );
  throwsWith(() => DUAL({ implementations: [{ kind: 'wasm', digest: 'sha256:x', abiVersion: 'wasm-core@1' }] }), 'abi.artifact');
  throwsWith(() => DUAL({ implementations: [JS_IMPL, { kind: 'native', digest: 'sha256:x', abiVersion: NATIVE_ABI_VERSION, locality: 'rust-native' }, { kind: 'native', digest: 'sha256:y', abiVersion: NATIVE_ABI_VERSION }] }), 'abi.artifact');
  throwsWith(() => DUAL({ implementations: [JS_IMPL, { kind: 'native', abiVersion: NATIVE_ABI_VERSION }] }), 'abi.artifact');
  assert.match(
    throwsWith(() => DUAL({ implementations: [{ ...JS_IMPL, abiVersion: NATIVE_ABI_VERSION }] }), 'abi.artifact').message,
    /would be a costume/,
  );
  assert.equal(isDualArtifact({ contract: ABI_CONTRACT, identity: 'a@1' }), false);
  assert.equal(isDualArtifact(null), false);
});

/* ------------------------------------------------------------------- vectors */

test('vectors are derived from the wire contract, so two implementations are asked the same questions', () => {
  const vectors = VECTORS();
  assert.equal(isConformanceVectors(vectors), true);
  assert.equal(vectors.vectors.length, 4);
  assert.deepEqual(vectors.vectors.map((vector) => vector.id), ['empty-item', 'full-item', 'unexpected-field', 'null-field']);
  assert.deepEqual({ ...vectors.vectors[1].input }, { id: 'text', count: 1 });
  assert.equal(vectors.vectors[2].expect, 'refused', 'the shape is closed, so an unexpected field is refused');
  assert.equal(vectors.vectors[3].expect, 'ok', 'a null in a declared field is a value, not an absence');
  assert.match(vectors.vectorDigest, /^[0-9a-f]{64}$/);
  const { vectorDigest, ...body } = vectors;
  assert.equal(vectorDigest, abiDigest(body));
  assert.deepEqual(VECTORS().vectorDigest, vectors.vectorDigest, 'the same contract produces the same questions');

  const open = VECTORS({ additionalProperties: true });
  assert.equal(open.vectors[2].expect, 'passed-through');
  assert.notEqual(open.vectorDigest, vectors.vectorDigest);
  const typed = VECTORS({ fields: { blob: 'binary', rows: 'array', flag: 'boolean' } });
  assert.equal(typed.vectors[1].input.blob, 'bytes-handle:0', 'binary crosses as a handle, exactly as the boundary rule says');
  assert.equal(typed.vectors[1].input.rows.length, 0);
  throwsWith(() => VECTORS({ identity: 'n8n-nodes-base.set' }), 'abi.input');
  throwsWith(() => VECTORS({ ioDigest: '' }), 'abi.vectors');
  throwsWith(() => VECTORS({ fields: ['id'] }), 'abi.vectors');
  throwsWith(() => VECTORS({ additionalProperties: 'open' }), 'abi.vectors');
  assert.equal(isConformanceVectors({ contract: ABI_CONTRACT }), false);
});

/* --------------------------------------------------------------- conformance */

test('a case that did not run is INCOMPLETE, and a disagreement is DIVERGENT with the case named', () => {
  const vectors = VECTORS();
  const report = compareConformance(vectors, { js: { ...ALL_OK, 'null-field': undefined }, native: { ...ALL_OK, 'full-item': 'refused' } });
  assert.equal(isConformanceReport(report), true);
  const [js, native] = report.reports;
  assert.equal(js.kind, 'js');
  assert.equal(js.verdict, 'INCOMPLETE');
  assert.equal(js.missing, 1);
  assert.equal(js.cases.find((entry) => entry.id === 'null-field').observed, null);
  assert.match(js.cases.find((entry) => entry.id === 'null-field').note, /no result was reported/);
  assert.equal(native.verdict, 'DIVERGENT');
  assert.equal(native.diverged, 1);
  assert.match(native.cases.find((entry) => entry.id === 'full-item').note, /expected 'ok' and observed 'refused'/);
  assert.match(report.reportDigest, /^[0-9a-f]{64}$/);
  assert.equal(compareConformance(vectors, { js: ALL_OK, native: ALL_OK }).reports.every((entry) => entry.verdict === 'MATCH'), true);
  // A result may carry a note, which travels with the case.
  const withNote = compareConformance(vectors, { js: { ...ALL_OK, 'empty-item': { outcome: 'ok', note: 'the node accepted an empty item and returned one' } } });
  assert.equal(withNote.reports[0].cases[0].note, 'the node accepted an empty item and returned one');
  throwsWith(() => compareConformance({}, { js: ALL_OK }), 'abi.input');
  throwsWith(() => compareConformance(vectors, { cpp: ALL_OK }), 'abi.input');
  throwsWith(() => compareConformance(vectors, { js: 'fine' }), 'abi.input');
  assert.equal(isConformanceReport({ contract: ABI_CONTRACT, reports: [] }), false);
});

test('two implementations that disagree are two nodes sharing a name', () => {
  const artifact = DUAL();
  const vectors = VECTORS();
  const agreeing = conformDualArtifact(artifact, { vectors, results: { js: ALL_OK, native: ALL_OK } });
  assert.equal(agreeing.ok, true);
  assert.equal(agreeing.verdict, 'MATCH');
  assert.match(agreeing.message, /every declared implementation matched the same 4 vectors/);
  assert.match(agreeing.evidenceDigest, /^[0-9a-f]{64}$/);
  assert.match(explainConformance(agreeing), /'n8n-nodes-base\.set@3\.4': MATCH/);

  const disagreeing = conformDualArtifact(artifact, { vectors, results: { js: ALL_OK, native: { ...ALL_OK, 'unexpected-field': 'passed-through' } } });
  assert.equal(disagreeing.ok, false);
  assert.equal(disagreeing.verdict, 'DIVERGENT');
  assert.match(disagreeing.message, /two implementations that disagree are two nodes sharing a name/);

  const oneWasNeverAsked = conformDualArtifact(artifact, { vectors, results: { js: ALL_OK } });
  assert.equal(oneWasNeverAsked.verdict, 'INCOMPLETE');
  assert.deepEqual([...oneWasNeverAsked.unasked], ['native']);
  assert.match(oneWasNeverAsked.message, /declared and never asked: a promise with a hole in it is not conformance/);

  const partial = conformDualArtifact(artifact, { vectors, results: { js: ALL_OK, native: { 'empty-item': 'ok' } } });
  assert.equal(partial.verdict, 'INCOMPLETE', 'a case nobody ran cannot be a case that passed');

  assert.match(
    throwsWith(() => conformDualArtifact(artifact, { vectors: VECTORS({ ioDigest: 'c'.repeat(64) }), results: { js: ALL_OK, native: ALL_OK } }), 'abi.vectors').message,
    /would prove nothing/,
  );
  throwsWith(() => conformDualArtifact(artifact, { vectors, results: { js: ALL_OK, wasm: ALL_OK } }), 'abi.conformance');
  throwsWith(() => conformDualArtifact({}, { vectors }), 'abi.input');
  throwsWith(() => conformDualArtifact(artifact, {}), 'abi.input');
});

/* ---------------------------------------------------------------- selection */

test('selection runs the implementation of the locality asked for, and a substitute is declared', () => {
  const artifact = DUAL();
  const native = selectImplementation(artifact, { locality: 'rust-native' });
  assert.equal(native.ok, true);
  assert.equal(native.implementation.kind, 'native');
  assert.equal(native.substituted, false);
  assert.match(native.message, /runs its native implementation in 'rust-native'/);
  assert.equal(selectImplementation(artifact, { locality: 'js-compat' }).implementation.kind, 'js');

  const refused = selectImplementation(artifact, { locality: 'wasm' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'abi.locality');
  assert.deepEqual([...refused.available], ['js (js-compat)', 'native (rust-native)']);
  assert.match(refused.message, /falling back would run it somewhere else, and that is a decision, not a convenience/);

  const substituted = selectImplementation(artifact, { locality: 'wasm', allowFallback: true });
  assert.equal(substituted.ok, true);
  assert.equal(substituted.substituted, true);
  assert.equal(substituted.requested, 'wasm');
  assert.equal(substituted.locality, 'js-compat', 'js sorts before native, so the substitution is deterministic');
  assert.match(substituted.message, /the substitution is declared and recorded/);
  assert.equal(selectImplementation(artifact, { locality: 'remote-worker', allowFallback: true }).ok, true);
  throwsWith(() => selectImplementation(artifact, { locality: 'gpu-tent' }), 'abi.locality');
  throwsWith(() => selectImplementation(artifact, { locality: 'wasm', allowFallback: 'yes' }), 'abi.selection');
  throwsWith(() => selectImplementation({ identity: 'a@1' }, { locality: 'wasm' }), 'abi.input');
});

/* -------------------------------------------------------------------- reads */

test('describing an artifact gives the counts a review opens with', () => {
  const described = describeDualArtifact(DUAL());
  assert.equal(described.identity, 'n8n-nodes-base.set@3.4');
  assert.equal(described.dual, true);
  assert.deepEqual([...described.kinds], ['js', 'native']);
  assert.equal(described.abiVersion, NATIVE_ABI_VERSION);
  assert.deepEqual([...described.implementations], ['js → js-compat (sha256:11111…)', 'native → rust-native (sha256:22222…)']);
  assert.equal(described.ioDigest, WIRE);
  assert.equal(described.semanticsDigest, SEMANTICS);
  assert.equal(Object.isFrozen(described), true);
  assert.equal(describeDualArtifact(DUAL({ implementations: [JS_IMPL] })).dual, false);
  throwsWith(() => describeDualArtifact({ identity: 'a@1' }), 'abi.input');
  throwsWith(() => explainConformance({ verdict: 'MATCH' }), 'abi.input');
});

/* --------------------------------------------------------------------- walls */

test('the ABI contract declares and selects: it loads, runs and compiles nothing', () => {
  const source = readFileSync(new URL('../src/lego/native-abi.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(', 'node:vm', 'eval(', 'WebAssembly', 'dlopen', 'ffi']) {
    assert.equal(code.includes(forbidden), false, `the ABI contract must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  for (const forbidden of ['./io-compiler.mjs', './semantic-fingerprint.mjs', './jit-lease.mjs', './runtime-pool.mjs', './cancel-accounting.mjs', './node-residency.mjs', './registry-compiler.mjs']) {
    assert.equal(code.includes(forbidden), false, `P6.25 must not reach into ${forbidden}: the wire digest, the field map and the semantics digest arrive as data`);
  }
  assert.ok(code.includes("from './node-registry.mjs'"), 'the locality vocabulary is P6.1\'s, quoted');
  for (const name of ['compileNodeIo', 'fingerprintNodeSemantics', 'requestLease', 'loadNode', 'placeOnPool']) {
    assert.equal(code.includes(name), false, `${name} belongs to another milestone`);
  }
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.abi');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, ABI_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/native-abi.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-native-abi.test.mjs']);
  for (const name of ['declareDualArtifact', 'conformanceVectors', 'compareConformance', 'conformDualArtifact', 'selectImplementation', 'describeDualArtifact']) {
    assert.equal(rows[0].exports['src/lego/native-abi.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'node.io', 'runtime.jit', 'runtime.cancel', 'runtime.pool', 'registry.compiler', 'node.admission', 'node.sbom', 'node.canary', 'node.revocation']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.25 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/native-abi.mjs'));
});
