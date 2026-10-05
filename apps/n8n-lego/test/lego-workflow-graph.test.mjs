/**
 * P3 Slice A — persistent logical graph (Issues #75/#97, marathon §30 Slice A).
 *
 * Proves: canonical stays authoritative · chunked partial reads · one-chunk
 * access (readStats) · name→ordinal index · lossless deep-equal roundtrip ·
 * n8n-editor contract checksum · fail-closed bundle integrity · determinism ·
 * no artificial node-count ceiling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GRAPH_CHUNK_DEFAULT_SIZE,
  GRAPH_HOT_CACHE_DEFAULT_CHUNKS,
  GRAPH_NODE_LIFECYCLE,
  GRAPH_RESIDENCY,
  WORKFLOW_GRAPH_BUNDLE_VERSION,
  WORKFLOW_GRAPH_CONTRACT,
  WORKFLOW_GRAPH_CONTRACT_VERSION,
  WORKFLOW_GRAPH_LIMITS,
  WorkflowGraphError,
  createWorkflowGraph,
  graphFromBundle,
} from '../src/lego/workflow-graph.mjs';
import { calculateWorkflowChecksum } from '../src/checksum.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');
const LOCK = JSON.parse(read('apps/n8n-lego/src/lego/contracts/contract-lock.json'));
const ROWS = LOCK.contracts ?? LOCK;
const DOMAINS = JSON.parse(read('apps/n8n-lego/src/lego/manifest/domains.json'));
const WORKFLOW = (DOMAINS.domains ?? DOMAINS).find((d) => d.id === 'workflow');
const ERRORS = JSON.parse(read('apps/n8n-lego/src/lego/contracts/errors.contract.json'));

const caught = (fn) => {
  try { fn(); return null; } catch (error) { return error; }
};

function sampleDefinition() {
  return {
    name: 'P3 slice A sample',
    settings: { timezone: 'Asia/Jakarta', executionOrder: 'v1' },
    meta: { instanceId: 'i-test' },
    pinData: { Start: [{ json: { seeded: true } }] },
    active: false,
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {}, id: 'n1' },
      { name: 'HTTP', type: 'n8n-nodes-base.httpRequest', typeVersion: 4, position: [200, 0], parameters: { url: 'https://example.test' }, id: 'n2' },
      { name: 'Branch', type: 'n8n-nodes-base.if', typeVersion: 2, position: [400, 0], parameters: {}, id: 'n3' },
      { name: 'Set A', type: 'n8n-nodes-base.set', typeVersion: 3, position: [600, -80], parameters: {}, id: 'n4' },
      { name: 'Set B', type: 'n8n-nodes-base.set', typeVersion: 3, position: [600, 80], parameters: {}, id: 'n5' },
    ],
    connections: {
      Start: { main: [[{ node: 'HTTP', type: 'main', index: 0 }]] },
      HTTP: { main: [[{ node: 'Branch', type: 'main', index: 0 }]] },
      Branch: { main: [[{ node: 'Set A', type: 'main', index: 0 }], [{ node: 'Set B', type: 'main', index: 0 }]] },
      'Set A': { main: [[]] },
      Ghost: { main: [[{ node: 'Start', type: 'main', index: 0 }]] },
    },
  };
}

/* ================================================= A. CONTRACT / LOCK ROW */

test('the lock row is the thirty-third: workflow.graph@1.0.0, owner agent-1, exports byte-parity', () => {
  const row = ROWS.find((r) => r.id === 'workflow.graph');
  assert.ok(row, 'workflow.graph is locked');
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(ROWS.length, 100, 'rows through P3 Slice C (workflow.graph stays thirty-third); P3 Slice D adds the thirty-fourth (execution.frontier); P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  assert.equal(row.owner, 'agent-1', 'Issue #98: Agent 1 owns the workflow graph');
  assert.equal(row.domain, 'workflow');
  assert.equal(row.version, '0.1.0', 'R9: matches the workflow domain contract version (0.1.0)');
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.surface, ['src/lego/workflow-graph.mjs']);
  const module_ = {
    GRAPH_CHUNK_DEFAULT_SIZE, GRAPH_HOT_CACHE_DEFAULT_CHUNKS, GRAPH_NODE_LIFECYCLE, GRAPH_RESIDENCY,
    WORKFLOW_GRAPH_BUNDLE_VERSION, WORKFLOW_GRAPH_CONTRACT,
    WORKFLOW_GRAPH_CONTRACT_VERSION, WORKFLOW_GRAPH_LIMITS, WorkflowGraphError,
    createWorkflowGraph, graphFromBundle,
  };
  const locked = row.exports['src/lego/workflow-graph.mjs'];
  assert.deepEqual([...locked].sort(), Object.keys(module_).sort(), 'lock ⇄ module exports');
  assert.equal(locked.length, 11, 'P3 Slice C adds exactly three additive exports');
  assert.deepEqual([...locked], [...locked].slice().sort(), 'sorted ASCII');
  assert.deepEqual(row.tests, ['apps/n8n-lego/test/lego-workflow-graph.test.mjs']);
  assert.equal('operations' in row, false, 'no capability/REST surface in Slice A (by design)');
  assert.equal('permissions' in row, false);
  assert.equal(WORKFLOW_GRAPH_CONTRACT.id, row.id);
  assert.equal(WORKFLOW_GRAPH_CONTRACT_VERSION, row.version);
  assert.equal(WORKFLOW_GRAPH_CONTRACT.owner, row.owner);
});

test('the workflow domain owns the module; no capability was added; the n8n checksum seam stays', () => {
  assert.ok(WORKFLOW.paths.includes('src/lego/workflow-graph.mjs'));
  assert.ok(WORKFLOW.paths.includes('src/checksum.mjs'), 'the checksum seam is still the domain');
  assert.equal(WORKFLOW.capabilities.length, 4, 'workflow.checksum/crud/history/source-control unchanged');
  assert.equal(WORKFLOW.status, 'partial', 'domain status unchanged by a slice');
  assert.equal(ERRORS.version, '1.2.0', 'errors contract untouched');
  // one error family, published code
  for (const match of readFileSync(join(REPO_ROOT, 'apps/n8n-lego/src/lego/workflow-graph.mjs'), 'utf8').matchAll(/'(lego\.[a-z0-9_]+)'/g)) {
    const published = new Set((ERRORS.codes ?? ERRORS.errors ?? []).map((e) => e.code ?? e.id));
    assert.ok(published.has(match[1]), `${match[1]} is published`);
  }
});

/* ==================================================== B. BUILD / VALIDATE */

test('a canonical definition builds a manifest carrying the n8n-editor checksum', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def);
  const manifest = graph.manifest();
  assert.equal(manifest.contract, 'workflow.graph@0.1.0');
  assert.equal(manifest.bundleVersion, WORKFLOW_GRAPH_BUNDLE_VERSION);
  assert.equal(manifest.checksum, calculateWorkflowChecksum(def), 'manifest checksum IS the n8n contract checksum');
  assert.equal(manifest.nodeCount, 5);
  assert.equal(manifest.edgeCount, 5, 'Start→HTTP, HTTP→Branch, Branch→A, Branch→B, Ghost→Start');
  assert.equal(manifest.chunkSize, GRAPH_CHUNK_DEFAULT_SIZE);
  assert.equal(manifest.chunkCount, Math.ceil(5 / GRAPH_CHUNK_DEFAULT_SIZE));
  assert.equal(typeof manifest.chunkDigest, 'string');
  assert.equal(manifest.chunkDigest.length, 64);
  assert.equal(manifest.canonical, true);
  assert.equal(graph.nodeCount(), 5);
  assert.equal(graph.edgeCount(), 5);
});

test('build is deterministic: two builds of the same definition produce identical manifests', () => {
  const def = sampleDefinition();
  const a = createWorkflowGraph(def).manifest();
  const b = createWorkflowGraph(def).manifest();
  assert.deepEqual(a, b, 'same input ⇒ same checksum, same chunk digest, same addressing');
});

test('the canonical input is never mutated by graph construction', () => {
  const def = sampleDefinition();
  const before = JSON.stringify(def);
  const graph = createWorkflowGraph(def, { chunkSize: 2 });
  graph.exportDefinition();
  graph.exportBundle();
  assert.equal(JSON.stringify(def), before, 'the author document stays byte-identical');
});

test('validation refuses malformed definitions with the one error family', () => {
  for (const bad of [null, 'def', 42, []]) {
    const error = caught(() => createWorkflowGraph(bad));
    assert.ok(error);
    assert.ok(error instanceof WorkflowGraphError);
    assert.equal(error.code, 'lego.contract_violation');
  }
  assert.match(caught(() => createWorkflowGraph({ connections: {} })).message, /nodes must be an array/);
  assert.match(caught(() => createWorkflowGraph({ nodes: [] })).message, /connections must be an object/);
  const dup = caught(() => createWorkflowGraph({
    nodes: [{ name: 'A', type: 't', position: [0, 0], parameters: {} }, { name: 'A', type: 't', position: [1, 1], parameters: {} }],
    connections: {},
  }));
  assert.equal(dup.details.reason, 'duplicate-name');
  const nameless = caught(() => createWorkflowGraph({ nodes: [{ type: 't' }], connections: {} }));
  assert.equal(nameless.details.field, 'node.name');
  const overlong = caught(() => createWorkflowGraph({ nodes: [{ name: 'x'.repeat(257) }], connections: {} }));
  assert.match(overlong.message, /1\.\.256/);
  assert.match(caught(() => createWorkflowGraph({ nodes: [], connections: {} }, { chunkSize: 0 })).message, /chunkSize/);
});

test('there is no artificial node-count ceiling — a large logical graph builds fine', () => {
  assert.equal('maxNodes' in WORKFLOW_GRAPH_LIMITS, false, 'anti-pattern 13: no artificial low node limit');
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ name: `N${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [i, 0], parameters: {} }));
  const graph = createWorkflowGraph({
    name: 'wide', nodes,
    connections: Object.fromEntries(nodes.map((n) => [n.name, { main: [] }])),
  });
  assert.equal(graph.nodeCount(), 5000);
  assert.equal(graph.chunkCount(), Math.ceil(5000 / GRAPH_CHUNK_DEFAULT_SIZE));
  assert.ok(graph.getNode('N4999'), 'the last logical node is reachable by index');
});

/* ================================== C. LOSSLESS ROUNDTRIP / CANONICAL TRUTH */

test('exportDefinition deep-equals the canonical definition (header + nodes + connections + orphans)', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def, { chunkSize: 2 });
  assert.deepStrictEqual(graph.exportDefinition(), def,
    'canonical recovery: same semantics, same data, orphan Ghost preserved');
  const bundleGraph = graphFromBundle(JSON.parse(JSON.stringify(graph.exportBundle())));
  assert.deepStrictEqual(bundleGraph.exportDefinition(), def);
  assert.equal(calculateWorkflowChecksum(bundleGraph.exportDefinition()),
    calculateWorkflowChecksum(def), 'the editor checksum survives every roundtrip');
});

test('bundle survives JSON serialization (durable wire format)', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def, { chunkSize: 2 });
  const wire = JSON.parse(JSON.stringify(graph.exportBundle()));
  assert.equal(wire.bundleVersion, WORKFLOW_GRAPH_BUNDLE_VERSION);
  const restored = graphFromBundle(wire);
  assert.deepStrictEqual(restored.exportDefinition(), def);
  assert.deepEqual(restored.manifest(), graph.manifest());
});

/* ============================================= D. CHUNKING / PARTIAL READS */

test('getChunk is a bounded partial read of exactly one chunk', () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ name: `N${i}`, type: 't', position: [i, 0], parameters: { v: i } }));
  const graph = createWorkflowGraph({ name: 'c', nodes, connections: {} }, { chunkSize: 3 });
  assert.equal(graph.chunkCount(), 3, '7 nodes / size 3 → chunks of 3,3,1');
  const first = graph.getChunk(0);
  assert.equal(first.length, 3);
  assert.deepEqual(first.map((n) => n.name), ['N0', 'N1', 'N2']);
  const last = graph.getChunk(2);
  assert.equal(last.length, 1);
  assert.deepEqual(last.map((n) => n.name), ['N6']);
  for (const bad of [-1, 3, 1.5, '0']) {
    const error = caught(() => graph.getChunk(bad));
    assert.ok(error, `chunk ${bad} refuses`);
    assert.equal(error.details.reason, 'out-of-range');
  }
});

test('one-chunk discipline: every single accessor touches exactly one chunk (readStats)', () => {
  const nodes = Array.from({ length: 3000 }, (_, i) => ({ name: `N${i}`, type: 't', position: [i, 0], parameters: {} }));
  const graph = createWorkflowGraph({ name: 'stats', nodes, connections: {} });
  graph.resetReadStats();
  graph.getNode('N0');
  assert.equal(graph.readStats().chunkReads, 1, 'getNode → exactly one chunk, never a scan');
  graph.getNode('N2999');
  assert.equal(graph.readStats().chunkReads, 2, 'last node still one chunk (index, not search)');
  graph.getChunk(1);
  assert.equal(graph.readStats().chunkReads, 3);
  graph.getOutgoingConnections('N0');
  assert.equal(graph.readStats().chunkReads, 4, 'edge reads are chunked too');
  graph.resetReadStats();
  assert.equal(graph.readStats().chunkReads, 0);
});

test('node access: hasNode, unknown-node refusal, ordinal-order iteration', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def, { chunkSize: 2 });
  assert.equal(graph.hasNode('HTTP'), true);
  assert.equal(graph.hasNode('Nope'), false);
  const error = caught(() => graph.getNode('Nope'));
  assert.equal(error.details.reason, 'unknown-node');
  const edgeError = caught(() => graph.getOutgoingConnections('Nope'));
  assert.equal(edgeError.details.reason, 'unknown-node');
  assert.deepEqual([...graph.nodeNames()], def.nodes.map((n) => n.name), 'iteration preserves canonical order');
});

test('connections are bucketed per source chunk and read back losslessly', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def, { chunkSize: 2 });
  assert.deepEqual(graph.getOutgoingConnections('Start'), def.connections.Start);
  assert.deepEqual(graph.getOutgoingConnections('Branch'), def.connections.Branch);
  assert.equal(graph.hasNode('Ghost'), false, 'an orphan connection key is NOT a node');
  assert.equal(caught(() => graph.getOutgoingConnections('Ghost')).details.reason, 'unknown-node',
    'identity rule: edge access is indexed by node ordinal; orphans survive via exportDefinition only');
  assert.deepEqual(graph.getOutgoingConnections('Set A'), def.connections['Set A']);
  assert.deepEqual(graph.getOutgoingConnections('Set B'), {}, 'a node without connections answers empty');
});

/* =========================================== E. INTEGRITY / FAIL-CLOSED LOAD */

test('integrity() re-verifies the resident digest and detects corruption', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def, { chunkSize: 2 });
  assert.equal(graph.integrity().ok, true);
  const bundle = JSON.parse(JSON.stringify(graph.exportBundle()));
  bundle.nodeChunks[0][0] = bundle.nodeChunks[0][0].replace('Start', 'StartTampered');
  const refused = caught(() => graphFromBundle(bundle));
  assert.ok(refused, 'a tampered bundle must be refused');
  assert.equal(refused.code, 'lego.contract_violation');
  assert.equal(refused.details.reason, 'integrity-mismatch');
  assert.match(refused.message, /integrity/);
});

test('graphFromBundle fails closed on structural damage before any node is served', () => {
  const def = sampleDefinition();
  const bundle = JSON.parse(JSON.stringify(createWorkflowGraph(def).exportBundle()));
  assert.match(caught(() => graphFromBundle(null)).message, /bundle/);
  const wrongVersion = { ...bundle, bundleVersion: 99 };
  wrongVersion.manifest = { ...bundle.manifest }; // digest path still guards below
  assert.equal(caught(() => graphFromBundle(wrongVersion)).details.reason, 'unsupported-version');
  const missingChunks = { ...bundle, nodeChunks: 'nope' };
  assert.match(caught(() => graphFromBundle(missingChunks)).message, /equal length|array/);
  const wrongCount = JSON.parse(JSON.stringify(bundle));
  wrongCount.manifest.nodeCount = wrongCount.manifest.nodeCount + 1;
  // digest still matches (manifest change only) → count check must catch it
  const countError = caught(() => graphFromBundle(wrongCount));
  assert.equal(countError.details.reason, 'count-mismatch');
});

/* ==================================== F. RESIDENCY SHAPE / P3 INVARIANT PROOF */

test('resident form stores strings and integers — not one live object per node', () => {
  const n = 4000;
  const nodes = Array.from({ length: n }, (_, i) => ({ name: `N${i}`, type: 't', position: [i, 0], parameters: { payload: `value-${i}` } }));
  const graph = createWorkflowGraph({ name: 'res', nodes, connections: {} });
  const bundle = graph.exportBundle();
  assert.ok(bundle.nodeChunks.every((chunk) => chunk.every((entry) => typeof entry === 'string')),
    'nodes live as verbatim JSON strings in the resident form');
  assert.equal(graph.integrity().ok, true);
  // the invariant: logical count exists as data, resident index holds integers
  // (name→ordinal), and accessing any single node never materializes the graph
  graph.resetReadStats();
  graph.getNode(`N${n - 1}`);
  assert.equal(graph.nodeCount(), n, 'logical size recorded');
  assert.equal(graph.readStats().chunkReads, 1, 'working set for a lookup = one chunk, not the graph');
});

test('manifest is frozen and readStats are copies — callers cannot corrupt the graph state', () => {
  const graph = createWorkflowGraph(sampleDefinition());
  const manifest = graph.manifest();
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(graph.readStats() === graph.readStats(), false, 'stats are value copies');
  const stats = graph.readStats();
  stats.chunkReads = 9999;
  graph.getNode('Start');
  assert.equal(graph.readStats().chunkReads, 1, 'external mutation of stats never lands inside');
});

/* ============================== G. SLICE B — INDEXED EDGE ACCESS */

test('the reverse index is lazy: not built at construction, 0 reads until asked', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2 });
  assert.equal(graph.hasReverseIndex(), false, 'deriving the index at build time would defeat laziness');
  graph.resetReadStats();
  assert.equal(graph.readStats().chunkReads, 0);
});

test('getIncoming materializes once (one read per edge bucket) then serves pure index hits', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2 });
  graph.resetReadStats();
  const incomingHTTP = graph.getIncoming('HTTP');
  assert.equal(graph.hasReverseIndex(), true);
  const buckets = graph.exportBundle().edgeChunks.filter((entry) => entry !== '').length;
  assert.equal(graph.readStats().chunkReads, buckets,
    'materialization = one read per NON-EMPTY edge bucket, once (empty buckets are never read)');
  assert.deepEqual(incomingHTTP, [{ source: 'Start', type: 'main', index: 0 }]);
  graph.getIncoming('Branch');
  graph.getIncoming('Set A');
  assert.equal(graph.readStats().chunkReads, buckets, 'subsequent lookups are index hits — 0 chunk reads');
  assert.equal(graph.releaseReverseIndex(), true, 'evict drops the derived index');
  assert.equal(graph.hasReverseIndex(), false);
  graph.getIncoming('Start');
  assert.equal(graph.hasReverseIndex(), true, 'rematerializes on demand');
  assert.equal(graph.readStats().chunkReads, buckets * 2, 'second build pays the bucket reads again');
});

test('reverse lookups are correct, ordered, frozen — and dangling targets are never indexed', () => {
  const def = sampleDefinition();
  def.connections.Branch.main[0].push({ node: 'Dangling', type: 'main', index: 1 });
  const graph = createWorkflowGraph(def, { chunkSize: 2 });
  assert.deepEqual(graph.getIncoming('Start'), [], 'Start has no indexed incoming edge (Ghost is not a node)');
  assert.deepEqual(graph.getIncoming('HTTP'), [{ source: 'Start', type: 'main', index: 0 }]);
  assert.deepEqual(graph.getIncoming('Branch'), [{ source: 'HTTP', type: 'main', index: 0 }]);
  assert.deepEqual(graph.getIncoming('Set A'), [{ source: 'Branch', type: 'main', index: 0 }],
    'output bundle 0 → Set A');
  assert.deepEqual(graph.getIncoming('Set B'), [{ source: 'Branch', type: 'main', index: 1 }],
    'index = which output bundle (main[1]) produced the edge');
  assert.equal(graph.hasNode('Dangling'), false);
  const frozen = graph.getIncoming('HTTP');
  assert.equal(Object.isFrozen(frozen), true, 'returned rows are frozen');
  assert.equal(Object.isFrozen(frozen[0]), true);
  const unknown = caught(() => graph.getIncoming('Nope'));
  assert.equal(unknown.details.reason, 'unknown-node', 'identity rule matches getNode');
  // the canonical definition still roundtrips with the dangling entry intact
  assert.deepStrictEqual(graph.exportDefinition(), def);
});

test('the reverse index is derived: never bundled, rebuilds after a bundle roundtrip', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2 });
  graph.getIncoming('HTTP');
  assert.equal(graph.hasReverseIndex(), true);
  const wire = JSON.parse(JSON.stringify(graph.exportBundle()));
  assert.equal('incoming' in wire, false, 'derived index never rides the durable bundle');
  assert.equal('reverseIndex' in wire, false);
  const restored = graphFromBundle(wire);
  assert.equal(restored.hasReverseIndex(), false, 'fresh graph starts without the index');
  assert.deepEqual(restored.getIncoming('HTTP'), [{ source: 'Start', type: 'main', index: 0 }]);
  assert.deepStrictEqual(restored.exportDefinition(), sampleDefinition());
});

/* ==================== H. SLICE C — MATERIALIZATION CONTROL ==================== */

test('Slice C publishes the lifecycle + residency vocabulary and the cache bound', () => {
  assert.deepEqual([...GRAPH_NODE_LIFECYCLE], [
    'DECLARED', 'INDEXED', 'RESOLVED', 'MATERIALIZED', 'READY',
    'EXECUTING', 'COMMITTED', 'EVICTABLE', 'EVICTED',
  ], 'the nine P3 stages in declared order');
  assert.equal(Object.isFrozen(GRAPH_NODE_LIFECYCLE), true, 'vocabulary is immutable');
  assert.deepEqual({ ...GRAPH_RESIDENCY }, { HOT: 'HOT', WARM: 'WARM', COLD: 'COLD' });
  assert.equal(Object.isFrozen(GRAPH_RESIDENCY), true);
  assert.equal(GRAPH_HOT_CACHE_DEFAULT_CHUNKS, 8, 'bounded default — never unbounded');
  const graph = createWorkflowGraph(sampleDefinition());
  const stats = graph.cacheStats();
  assert.equal(stats.maxCachedChunks, GRAPH_HOT_CACHE_DEFAULT_CHUNKS);
  assert.equal(stats.storeKind, 'memory', 'default port = Slice A baseline behaviour');
});

test('materialization options validate fail-closed in the one error family', () => {
  const def = sampleDefinition();
  for (const bad of [-1, 1.5, '4', 65537, Number.NaN]) {
    const error = caught(() => createWorkflowGraph(def, { maxCachedChunks: bad }));
    assert.ok(error instanceof WorkflowGraphError, `maxCachedChunks ${bad} refuses`);
    assert.equal(error.details.field, 'maxCachedChunks');
    assert.equal(error.code, 'lego.contract_violation');
  }
  const lazyError = caught(() => createWorkflowGraph(def, { lazy: 'yes' }));
  assert.equal(lazyError.details.field, 'lazy');
  const bundle = JSON.parse(JSON.stringify(createWorkflowGraph(def).exportBundle()));
  assert.equal(caught(() => graphFromBundle(bundle, { maxCachedChunks: -2 })).details.field, 'maxCachedChunks');
  assert.equal(caught(() => graphFromBundle(bundle, { lazy: 1 })).details.field, 'lazy');
  // valid bounds (0 = HOT disabled) are accepted
  const zero = createWorkflowGraph(def, { maxCachedChunks: 0 });
  assert.equal(zero.cacheStats().maxCachedChunks, 0);
  const wide = createWorkflowGraph(def, { maxCachedChunks: 65536, lazy: true });
  assert.equal(wide.cacheStats().maxCachedChunks, 65536);
});

test('the HOT cache serves repeat reads as frozen shared state (logical reads still counted)', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2, maxCachedChunks: 4 });
  graph.resetReadStats();
  const first = graph.getChunk(0);
  assert.equal(graph.readStats().chunkReads, 1, 'a cold read is still exactly one logical chunk read');
  let stats = graph.cacheStats();
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 0);
  assert.equal(stats.hot, 1);
  const second = graph.getChunk(0);
  assert.equal(graph.readStats().chunkReads, 2, 'a HOT hit is still one logical read — no hidden scan');
  stats = graph.cacheStats();
  assert.equal(stats.hits, 1, 'second read served from the HOT cache');
  assert.equal(first, second, 'the cache serves the shared resident entry');
  assert.deepEqual(first.map((n) => n.name), ['Start', 'HTTP']);
  assert.equal(Object.isFrozen(first), true, 'shared cache arrays are immutable');
  assert.equal(Object.isFrozen(first[0]), true, 'shared node payloads are immutable');
  assert.throws(() => first.push({ name: 'Corrupt' }), TypeError, 'mutation of resident state is refused');
  assert.equal(stats.hot, 1, 'the failed mutation never entered the cache');
  // node + edge accessors hit the same materialized entry
  graph.getNode('Start');
  graph.getOutgoingConnections('Start');
  assert.equal(graph.cacheStats().hits, 3, 'node and edge reads reuse the HOT entry');
});

test('peak resident working set stays within maxCachedChunks while walking a much larger logical graph', () => {
  const n = 4000;
  const chunkSize = 64;
  const bound = 4;
  const nodes = Array.from({ length: n }, (_, i) => (
    { name: `N${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [i, 0], parameters: { payload: `v${i}` } }
  ));
  const def = { name: 'working-set', nodes, connections: {} };
  const graph = createWorkflowGraph(def, { chunkSize, maxCachedChunks: bound });
  assert.equal(graph.chunkCount(), Math.ceil(n / chunkSize), 'logical graph = 63 chunks');
  assert.ok(graph.chunkCount() > bound * 10, 'logical size far exceeds the resident bound');
  let peakHot = 0;
  for (let pass = 0; pass < 3; pass += 1) {
    for (let chunkIndex = 0; chunkIndex < graph.chunkCount(); chunkIndex += 1) {
      graph.getChunk(chunkIndex);
      const hot = graph.cacheStats().hot;
      assert.ok(hot <= bound, `peak HOT ${hot} never exceeds the bound ${bound} (pass ${pass})`);
      if (hot > peakHot) peakHot = hot;
    }
  }
  const stats = graph.cacheStats();
  assert.equal(peakHot, bound, 'the bound is reached but never crossed');
  assert.equal(stats.hot, bound);
  assert.equal(stats.misses, 3 * graph.chunkCount(), 'every chunk read each pass is a materialization');
  assert.equal(stats.evictions, stats.misses - bound, 'LRU invariant: inserts − survivors = evictions');
  // lifecycle under age-out pressure: an early chunk that scrolled out is RESOLVED (WARM), never lost
  assert.equal(graph.residencyOf(0), 'WARM', 'memory port keeps raw resident after HOT age-out');
  assert.equal(graph.lifecycleOf('N0'), 'RESOLVED', 'age-out is not an explicit evict — no EVICTED marker');
  assert.equal(graph.lifecycleOf(`N${n - 1}`), 'MATERIALIZED', 'last touched chunk is still HOT');
  // lossless canonical export despite the churn
  assert.deepStrictEqual(graph.exportDefinition(), def, 'working-set bounds never cost correctness');
  assert.equal(graph.integrity().ok, true);
});

test('memory-port residency: WARM at rest → HOT on access → evictChunk → EVICTED until rematerialization', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2 });
  assert.equal(graph.residencyOf(0), 'WARM', 'memory port: raw payload resident (Slice A baseline)');
  assert.equal(graph.lifecycleOf('Start'), 'RESOLVED', 'resident payload, not yet materialized');
  graph.getChunk(0);
  assert.equal(graph.residencyOf(0), 'HOT');
  assert.equal(graph.lifecycleOf('Start'), 'MATERIALIZED');
  assert.equal(graph.evictChunk(0), true, 'explicit evict drops the HOT entry');
  assert.equal(graph.residencyOf(0), 'WARM', 'memory port has no cold tier — raw stays resident');
  assert.equal(graph.lifecycleOf('Start'), 'EVICTED', 'the explicit-evict marker stands until re-read');
  graph.getChunk(0);
  assert.equal(graph.lifecycleOf('Start'), 'MATERIALIZED', 'rematerialization clears the marker');
  assert.equal(graph.evictChunk(0), true);
  assert.equal(graph.evictChunk(0), false, 'already evicted — nothing left to drop');
  assert.equal(graph.lifecycleOf('Start'), 'EVICTED', 'marker persists across idempotent evicts');
  assert.equal(caught(() => graph.lifecycleOf('Nope')).details.reason, 'unknown-node');
  assert.equal(caught(() => graph.residencyOf(-1)).details.reason, 'out-of-range');
  assert.equal(caught(() => graph.evictChunk(99)).details.reason, 'out-of-range');
});

test('lazy port: COLD at rest loads on demand, evicts to COLD/EVICTED, reloads losslessly', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def, { chunkSize: 2, maxCachedChunks: 2, lazy: true });
  const initial = graph.cacheStats();
  assert.equal(initial.storeKind, 'lazy');
  assert.equal(initial.storeLoads, 0, 'construction loads nothing — logical ≠ resident');
  assert.equal(initial.storeResident, 0);
  assert.equal(graph.residencyOf(0), 'COLD');
  assert.equal(graph.lifecycleOf('Start'), 'INDEXED', 'identity known, payload virtual until read');
  assert.equal(graph.hasNode('HTTP'), true, 'the index answers without any payload resident');
  graph.getChunk(0);
  const afterLoad = graph.cacheStats();
  assert.ok(afterLoad.storeLoads >= 1, 'a cold read loads through the store port');
  assert.equal(graph.residencyOf(0), 'HOT');
  assert.equal(graph.lifecycleOf('Start'), 'MATERIALIZED');
  assert.equal(graph.evictChunk(0), true, 'evict drops HOT and the raw window entry');
  assert.equal(graph.residencyOf(0), 'COLD', 'lazy port returns the chunk to the cold medium');
  assert.equal(graph.lifecycleOf('Start'), 'EVICTED');
  const loadsBefore = graph.cacheStats().storeLoads;
  const chunk = graph.getChunk(0);
  assert.ok(graph.cacheStats().storeLoads > loadsBefore, 'a COLD miss reloads from the source');
  assert.equal(graph.lifecycleOf('Start'), 'MATERIALIZED');
  assert.deepEqual(chunk.map((x) => x.name), ['Start', 'HTTP'], 'reloaded payload identical');
  assert.deepStrictEqual(graph.exportDefinition(), def, 'lossless after load → evict → reload churn');
  assert.equal(graph.integrity().ok, true);
});

test('lazy working set: HOT and raw window both stay bounded; reverse index builds under COLD residency', () => {
  const n = 5000;
  const chunkSize = 64;
  const bound = 4;
  const nodes = Array.from({ length: n }, (_, i) => (
    { name: `N${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [i, 0], parameters: {} }
  ));
  const connections = Object.fromEntries(nodes.map((node, i) => [
    node.name,
    { main: i < n - 1 ? [[{ node: `N${i + 1}`, type: 'main', index: 0 }]] : [] },
  ]));
  const def = { name: 'lazy-wide', nodes, connections };
  const graph = createWorkflowGraph(def, { chunkSize, maxCachedChunks: bound, lazy: true });
  assert.equal(graph.chunkCount(), 79, '5000 nodes / 64 per chunk → 79 logical chunks');
  assert.equal(graph.manifest().edgeCount, n - 1, 'chain edges recorded');
  for (let chunkIndex = 0; chunkIndex < graph.chunkCount(); chunkIndex += 1) {
    graph.getChunk(chunkIndex);
    const stats = graph.cacheStats();
    assert.ok(stats.hot <= bound, `HOT ${stats.hot} ≤ ${bound} at chunk ${chunkIndex}`);
    assert.ok(stats.storeResident <= bound, `raw window ${stats.storeResident} ≤ ${bound} at chunk ${chunkIndex}`);
  }
  let stats = graph.cacheStats();
  assert.equal(stats.storeLoads, graph.chunkCount(), 'single pass loads each cold chunk exactly once');
  assert.equal(stats.storeEvictions, stats.storeLoads - bound, 'window LRU invariant: loads − survivors = evictions');
  assert.equal(stats.evictions, stats.misses - bound, 'HOT LRU invariant holds under pressure too');
  // the derived reverse index builds from COLD chunks without breaking the bounds
  graph.getIncoming('N1');
  assert.deepEqual(graph.getIncoming('N1'), [{ source: 'N0', type: 'main', index: 0 }]);
  assert.deepEqual(graph.getIncoming('N0'), []);
  stats = graph.cacheStats();
  assert.ok(stats.hot <= bound && stats.storeResident <= bound, 'index build never breaks the working-set bounds');
  assert.equal(graph.releaseReverseIndex(), true);
  // durable roundtrip stays lossless after all of it
  const wire = JSON.parse(JSON.stringify(graph.exportBundle()));
  const restored = graphFromBundle(wire);
  assert.deepStrictEqual(restored.exportDefinition(), def, 'bundle roundtrip lossless after residency churn');
});

test('maxCachedChunks: 0 disables the HOT layer but reads stay correct (pure pass-through)', () => {
  const def = sampleDefinition();
  const graph = createWorkflowGraph(def, { chunkSize: 2, maxCachedChunks: 0 });
  graph.resetReadStats();
  const chunk = graph.getChunk(0);
  assert.deepEqual(chunk.map((n) => n.name), ['Start', 'HTTP']);
  let stats = graph.cacheStats();
  assert.equal(stats.hot, 0, 'no HOT layer when the bound is zero');
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 1);
  assert.equal(graph.readStats().chunkReads, 1, 'logical read discipline unchanged');
  assert.equal(graph.getChunk(0) === chunk, false, 'pass-through never shares a resident entry');
  stats = graph.cacheStats();
  assert.equal(stats.misses, 2, 'every read re-materializes without a cache');
  assert.equal(graph.residencyOf(0), 'WARM', 'memory port floor is unchanged');
  assert.equal(graph.lifecycleOf('Start'), 'RESOLVED', 'nothing reached HOT, so nothing is MATERIALIZED');
  assert.deepStrictEqual(graph.exportDefinition(), def, 'correctness holds with the cache disabled');
});

/* ============================== I. SLICE G — TIER PRESSURE / HOT-WARM-COLD */

test('residencySummary census: HOT+WARM+COLD = chunkCount, reverse-index flag honest', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2, maxCachedChunks: 2 });
  let summary = graph.residencySummary();
  assert.deepEqual({ ...summary }, { HOT: 0, WARM: 3, COLD: 0, chunkCount: 3, reverseIndexResident: false });
  graph.getChunk(0);
  graph.getChunk(1);
  graph.getIncoming('HTTP');
  summary = graph.residencySummary();
  assert.equal(summary.HOT, 2, 'both touched chunks materialized');
  assert.equal(summary.WARM, 1, 'untouched chunk stays raw-resident');
  assert.equal(summary.HOT + summary.WARM + summary.COLD, summary.chunkCount, 'census partitions the graph');
  assert.equal(summary.reverseIndexResident, true, 'derived index observed');
  assert.equal(Object.isFrozen(summary), true);
});

test('applyPressure demotes the OLDEST HOT entries to the target (explicit EVICTED, lossless reload)', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2, maxCachedChunks: 3 });
  graph.getChunk(0); graph.getChunk(1); graph.getChunk(2); // all three HOT
  graph.getChunk(0); // refresh chunk 0 → LRU order now 1,2,0 (oldest = 1)
  assert.equal(graph.residencySummary().HOT, 3);
  const result = graph.applyPressure({ targetHotChunks: 1, releaseReverseIndex: false });
  assert.equal(result.hotBefore, 3);
  assert.equal(result.hotAfter, 1, 'trim stops exactly at the target');
  assert.equal(result.released, 2, 'two oldest entries released');
  assert.equal(result.reverseIndexReleased, false, 'index preserved when not requested');
  assert.equal(graph.residencySummary().HOT, 1, 'the refreshed chunk 0 survived — policy frees OLDEST first');
  assert.equal(graph.residencyOf(0), 'HOT');
  assert.equal(graph.residencyOf(1), 'WARM', 'raw payload stays resident (memory port has no cold tier)');
  // released chunks read EVICTED until re-read …
  assert.equal(graph.lifecycleOf('Branch'), 'EVICTED', 'chunk 1 (oldest) explicitly released');
  const back = graph.getChunk(1);
  assert.equal(back.length, 2, 'reload serves the identical payload');
  assert.equal(graph.lifecycleOf('Branch'), 'MATERIALIZED', 're-read clears the marker');
  // lossless under pressure
  assert.deepStrictEqual(graph.exportDefinition(), sampleDefinition());
  assert.equal(graph.integrity().ok, true);
});

test('applyPressure() defaults = full emergency relief (HOT→0, index off); recovery works', () => {
  const graph = createWorkflowGraph(sampleDefinition(), { chunkSize: 2, maxCachedChunks: 4 });
  graph.getChunk(0); graph.getChunk(1);
  graph.getIncoming('Set A');
  assert.equal(graph.residencySummary().reverseIndexResident, true);
  const result = graph.applyPressure();
  assert.equal(result.targetHotChunks, 0, 'default target = zero parsed payload resident');
  assert.equal(result.hotAfter, 0);
  assert.equal(result.released, 2);
  assert.equal(result.reverseIndexReleased, true, 'default drops the derived index too (#79 step 3)');
  const summary = graph.residencySummary();
  assert.equal(summary.HOT, 0, 'working set fully relieved');
  assert.equal(summary.WARM, 3, 'raw tier untouched by pressure (Slice C owns the window)');
  assert.equal(summary.reverseIndexResident, false);
  // recovery: access rematerializes everything on demand, losslessly
  assert.deepEqual(graph.getChunk(0).map((n) => n.name), ['Start', 'HTTP']);
  assert.equal(graph.residencySummary().HOT, 1);
  assert.deepEqual(graph.getIncoming('HTTP'), [{ source: 'Start', type: 'main', index: 0 }]);
  assert.equal(graph.residencySummary().reverseIndexResident, true, 'derived index rebuilds after relief');
  assert.deepStrictEqual(graph.exportDefinition(), sampleDefinition(), 'lossless through the pressure cycle');
  // validation
  assert.equal(caught(() => graph.applyPressure({ targetHotChunks: 9 })).details.field, 'targetHotChunks');
  assert.equal(caught(() => graph.applyPressure({ targetHotChunks: -1 })).details.field, 'targetHotChunks');
  assert.equal(caught(() => graph.applyPressure({ releaseReverseIndex: 'yes' })).details.field, 'releaseReverseIndex');
  assert.equal(caught(() => graph.applyPressure(null)).details.field, 'options');
});

// ─────────────────────────────────────────────────────────────
// Slice I — execution-as-query: fan bounds + bounded ready queries.
// ─────────────────────────────────────────────────────────────

/** Slice I fixture: nodes + [from, to] edges (+ optional raw connections) → exported bundle. */
function bundleOf({ nodes, edges = [], connections }) {
  const bySource = {};
  for (const [from, to] of edges) {
    if (bySource[from] === undefined) bySource[from] = { main: [[]] };
    bySource[from].main[0].push({ node: to, type: 'main', index: 0 });
  }
  const def = {
    name: 'P3 slice I sample',
    nodes: nodes.map((name, i) => ({
      name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [i * 100, 0], parameters: {}, id: `n${i}`,
    })),
    connections: connections ?? bySource,
  };
  return createWorkflowGraph(def).exportBundle();
}

test('SLICE I: fanOutOf / fanInOf expose bounded fan-out/in coordination (#75 #3)', () => {
  const graph = graphFromBundle(bundleOf({
    nodes: ['A', 'Branch', 'Left', 'Right', 'Join'],
    edges: [['A', 'Branch'], ['Branch', 'Left'], ['Branch', 'Right'], ['Left', 'Join'], ['Right', 'Join']],
  }));
  assert.equal(graph.fanOutOf('A'), 1);
  assert.equal(graph.fanOutOf('Branch'), 2);
  assert.equal(graph.fanOutOf('Join'), 0);
  assert.equal(graph.fanInOf('Join'), 2);
  assert.equal(graph.fanInOf('A'), 0);
  assert.equal(caught(() => graph.fanOutOf('ghost')).details.reason, 'unknown-node');
  assert.equal(caught(() => graph.fanInOf('ghost')).details.reason, 'unknown-node');
});

test('SLICE I: dangling sources are not indexed — fan-in 0, node stays root (structural truth)', () => {
  const graph = graphFromBundle(bundleOf({
    nodes: ['Start'],
    edges: [],
    connections: { main: [[{ node: 'Ghost', type: 'main', index: 0 }]] },
  }));
  assert.equal(graph.fanInOf('Start'), 0); // dangling source excluded from the index
  const page = graph.initialReady({ limit: 1 });
  assert.deepEqual([...page.ready], ['Start']); // never blocked by a non-node
});

test('SLICE I: initialReady paginates cold-start discovery (stateless cursors)', () => {
  const graph = graphFromBundle(bundleOf({
    nodes: ['I0', 'I1', 'I2', 'I3', 'I4', 'Chain'],
    edges: [['I4', 'Chain']],
    // five isolated nodes = five roots; page them without materializing the whole set
  }));
  const p0 = graph.initialReady({ limit: 2, fromOrdinal: 0 });
  assert.equal(p0.ready.length, 2);
  assert.equal(p0.done, false);
  const p1 = graph.initialReady({ limit: 2, fromOrdinal: p0.next });
  assert.equal(p1.ready.length, 2);
  const p2 = graph.initialReady({ limit: 2, fromOrdinal: p1.next });
  assert.deepEqual([...p2.ready], ['I4']);
  assert.equal(p2.done, true);
  assert.equal(caught(() => graph.initialReady({ limit: 0 })).details.field, 'limit');
  assert.equal(caught(() => graph.initialReady({ limit: 2, fromOrdinal: -1 })).details.field, 'fromOrdinal');
  assert.equal(caught(() => graph.initialReady({})).details.field, 'limit');
  assert.equal(caught(() => graph.initialReady({ limit: 99 })).details.field, 'limit'); // cap = nodeCount
});

test('SLICE I: readyAfter — bounded incremental query, no whole-graph scan, fan-in coordinated', () => {
  const graph = graphFromBundle(bundleOf({
    nodes: ['A', 'B', 'C', 'D', 'X'],
    edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['X', 'D']],
  }));
  // cold start: satisfied empty → nothing incremental yet (roots come from initialReady)
  assert.deepEqual([...graph.readyAfter([])], []);
  // after A: successors B, C — each has all preds satisfied → both ready
  assert.deepEqual([...graph.readyAfter(['A'])], ['B', 'C']);
  // after A+B: D still waits on C AND X (all indexed preds must be satisfied)
  assert.deepEqual([...graph.readyAfter(['A', 'B'])], ['C']);
  // after A+B+X: D's preds = B, C?, X — C still missing
  assert.deepEqual([...graph.readyAfter(['A', 'B', 'X'])], ['C']);
  // full satisfaction of D's preds (B, C, X) — candidates = successors of the set = D
  assert.deepEqual([...graph.readyAfter(['A', 'B', 'C', 'X'])], ['D']);
  // canonical ordinal order, frozen result
  const ready = graph.readyAfter(['A']);
  assert.ok(Object.isFrozen(ready));
  assert.equal(caught(() => graph.readyAfter(['A', 'ghost'])).details.reason, 'unknown-node');
  assert.equal(caught(() => graph.readyAfter('A')).details.field, 'satisfied'); // bare string rejected
});

test('SLICE I: readyAfter terminates on cycles (event semantics, no deadlock)', () => {
  const graph = graphFromBundle(bundleOf({
    nodes: ['A', 'B'],
    edges: [['A', 'B'], ['B', 'A']],
  }));
  assert.deepEqual([...graph.initialReady({ limit: 2 }).ready], []); // pure cycle: no roots
  // once A fires, B's inbound edge is satisfied — event semantics, not structural acyclicity
  assert.deepEqual([...graph.readyAfter(['A'])], ['B']);
  // monotone NEWLY-ready semantics: satisfied nodes are never re-reported —
  // convergence to empty on the cycle (re-fire policy belongs to the runner,
  // out of the graph query's scope, so termination is structural)
  assert.deepEqual([...graph.readyAfter(['A', 'B'])], []);
});

test('SLICE I: readyAfter cost is bounded by satisfied × fan-out (work proportional to batch)', () => {
  // wide chain-level graph: 200 nodes in two layers; query after a 1-node batch
  const nodes = ['Root'];
  const edges = [];
  for (let i = 0; i < 200; i += 1) {
    const name = `W${i}`;
    nodes.push(name);
    edges.push(['Root', name]);
  }
  const graph = graphFromBundle(bundleOf({ nodes, edges }));
  const t0 = performance.now();
  const ready = graph.readyAfter(['Root']);
  const ms = performance.now() - t0;
  assert.equal(ready.length, 200);
  assert.ok(ms < 1000, `readyAfter batch query took ${ms.toFixed(1)} ms`);
  // bounded: one root + 200 leaves — successors of {Root} = 200, each fan-in 1
  assert.equal(graph.fanOutOf('Root'), 200);
});
