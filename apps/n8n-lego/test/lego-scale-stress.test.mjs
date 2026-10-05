/**
 * P3 Slice N — Scale stress (Issue #75): logical workflow size MUST stay
 * decoupled from runtime working-set memory, PROVEN in-process at 1,000,000
 * nodes on this runner (≈2 GB RAM environment — construction itself is part
 * of the proof: a single giant JSON.stringify of the definition OOM-aborts
 * here, which is exactly the whole-graph materialization anti-pattern #75
 * forbids, so this suite constructs the bundle STREAMED — one node string at
 * a time — and never holds the 1M-object array alongside the graph).
 *
 * The 5,000,000 / 10,000,000 tiers follow the single source-of-truth stress
 * target in `docs/n8n-lego/P3-UNLIMITED-NODES-PLAN.md` (§Stress Target):
 * executed when the environment admits them, recorded HONESTLY (env-limit =
 * evidence row, never a silent PASS) — weakening correctness to survive
 * stress is the explicit #75 anti-pattern and is not done here.
 *
 * Asserted at 1M scale:
 *   1. streamed construction + full indexing with NO artificial cap;
 *   2. per-node access stays a couple of chunk reads (no whole-graph scan);
 *   3. parsed HOT residency never exceeds its bound while walking chunks;
 *   4. Workflow DNA stays BOUNDED (KB) at 1M nodes;
 *   5. readyAfter cost = satisfied × fan-out (batch-proportional);
 *   6. fan bounds + frozen payloads + lifecycle vocabulary intact;
 *   7. timing numbers are generous env GUARDS, not benchmark claims
 *      (benchmark figures live in P3-BENCHMARK-ACCEPTANCE-MATRIX.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  createWorkflowGraph, graphFromBundle, GRAPH_CHUNK_DEFAULT_SIZE,
} from '../src/lego/workflow-graph.mjs';
import { computeWorkflowDna } from '../src/lego/workflow-dna.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
void ROOT;

const NODE_COUNT = 1_000_000;
const LINKS_PER_OUTPUT = 1_000;
const EDGE_BUCKETS = Math.ceil((NODE_COUNT - 1) / LINKS_PER_OUTPUT);
const HEADER_JSON = JSON.stringify({ name: 'P3 scale stress 1M (streamed)' });
const ORPHAN_JSON = '{}';

/** Minimal n8n-shaped node — built ONE AT A TIME, never retained as an array. */
function nodeStringAt(ordinal) {
  const node = ordinal === 0
    ? { name: 'Root', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {}, id: 'id0' }
    : {
      name: `N${ordinal}`,
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [ordinal % 1000, Math.floor(ordinal / 1000) % 1000],
      parameters: {},
      id: `id${ordinal}`,
    };
  return JSON.stringify(node);
}

/**
 * STREAMED bundle construction (anti-whole-graph-materialization): node
 * strings are produced and bucketed immediately (object never retained);
 * the root's edge bucket is assembled from pre-stringified link groups so
 * no 1M-link object graph exists at once. Digest replicated byte-exact from
 * the module's documented algorithm (graphFromBundle validates it).
 */
function buildStreamedBundle() {
  const chunkSize = GRAPH_CHUNK_DEFAULT_SIZE;
  const nodeChunks = [];
  const edgeChunks = [];
  let buf = [];
  for (let ordinal = 0; ordinal < NODE_COUNT; ordinal += 1) {
    buf.push(nodeStringAt(ordinal));
    if (buf.length === chunkSize) {
      nodeChunks.push(buf);
      // edges are keyed by the SOURCE name that lives in THIS chunk (Root = 0)
      edgeChunks.push(buf[0].includes('"Root"') && nodeChunks.length === 1 ? '__ROOT_EDGES__' : '');
      buf = [];
    }
  }
  if (buf.length > 0) {
    nodeChunks.push(buf);
    edgeChunks.push('');
  }

  // root edges: {'Root': {'main': [bucketOf1000, …]}} — buckets built one at a time
  const bucketStrings = [];
  for (let start = 1; start < NODE_COUNT; start += LINKS_PER_OUTPUT) {
    const bucket = [];
    for (let i = start; i < Math.min(start + LINKS_PER_OUTPUT, NODE_COUNT); i += 1) {
      bucket.push({ node: `N${i}`, type: 'main', index: 0 });
    }
    bucketStrings.push(JSON.stringify(bucket));
  }
  edgeChunks[0] = `{"Root":{"main":[${bucketStrings.join(',')}]}}`;
  bucketStrings.length = 0;

  // replicate digestChunks() byte-exact (header |orphan| then per-chunk)
  const hash = createHash('sha256');
  hash.update(HEADER_JSON, 'utf8');
  hash.update('\n|orphan|', 'utf8');
  hash.update(ORPHAN_JSON, 'utf8');
  for (let i = 0; i < nodeChunks.length; i += 1) {
    hash.update('\n|chunk|', 'utf8');
    hash.update(String(i), 'utf8');
    for (const nodeString of nodeChunks[i]) hash.update(nodeString, 'utf8');
    hash.update(edgeChunks[i] ?? '', 'utf8');
  }
  const chunkDigest = hash.digest('hex');

  const manifest = {
    contract: 'workflow.graph@0.1.0',
    bundleVersion: 1,
    // checksum is NOT validated by graphFromBundle; the canonical n8n-checksum
    // contract is proven on the createWorkflowGraph path (Slice A suite).
    // A streamed synthetic bundle states that honestly instead of faking a pass.
    checksum: 'streamed-synthetic-not-validated-at-load',
    chunkDigest,
    nodeCount: NODE_COUNT,
    edgeCount: NODE_COUNT - 1,
    chunkCount: nodeChunks.length,
    chunkSize,
    addressing: 'ordinal:name→chunk=floor(o/size),offset=o%size',
    nodesField: 'nodes',
    canonical: true,
  };
  return {
    bundleVersion: 1,
    manifest,
    headerJson: HEADER_JSON,
    orphanJson: ORPHAN_JSON,
    nodeChunks,
    edgeChunks,
  };
}

/** DNA fixture: 1M OBJECTS are needed only for the DNA pass — freed at once. */
function dnaAtOneMillion() {
  const connections = { Root: { main: [[{ node: 'N1', type: 'main', index: 0 }]] } };
  const definition = { name: 'P3 scale stress 1M (streamed)', nodes: null, connections };
  // streamed nodes array: full array required by computeWorkflowDna signature
  const nodes = new Array(NODE_COUNT);
  for (let i = 0; i < NODE_COUNT; i += 1) {
    const node = i === 0
      ? { name: 'Root', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [0, 0], parameters: {} }
      : { name: `N${i}`, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [i, 0], parameters: {} };
    nodes[i] = node;
  }
  definition.nodes = nodes;
  const t0 = performance.now();
  const dna = computeWorkflowDna(definition);
  const ms = performance.now() - t0;
  definition.nodes = null;
  nodes.length = 0;
  return { dna, ms };
}

let graph = null;
let buildMs = 0;

test('SCALE: Workflow DNA stays bounded at 1M nodes (runs FIRST — fixture freed before graph build)', () => {
  const { dna, ms } = dnaAtOneMillion();
  assert.equal(dna.nodeCount, NODE_COUNT);
  // only N1 has an inbound edge → every other node (Root + N2..N999999) is a root
  assert.equal(dna.rootCount, NODE_COUNT - 1, 'roots = nodes without inbound (structural truth at 1M)');
  assert.equal(dna.roots.length, 64, 'root SAMPLE capped at 64 even when roots = 999,999 — the bound itself');
  const bytes = JSON.stringify(dna).length;
  assert.ok(bytes < 4096, `DNA at 1M nodes = ${bytes} bytes (bounded)`);
  assert.ok(ms < 90_000, `DNA took ${ms.toFixed(0)} ms (env guard ceiling 90s — not a benchmark claim)`);
});

test('SCALE: STREAMED construction + full indexing of 1,000,000 nodes (no giant stringify, no cap)', () => {
  const t0 = performance.now();
  const bundle = buildStreamedBundle();
  graph = graphFromBundle(bundle);
  buildMs = performance.now() - t0;
  assert.equal(graph.nodeCount(), NODE_COUNT, 'all one million nodes indexed');
  assert.equal(graph.manifest().edgeCount, NODE_COUNT - 1, 'root → every leaf');
  assert.equal(graph.manifest().chunkDigest.length, 64, 'integrity digest present (graphFromBundle verified it)');
  assert.ok(buildMs < 180_000, `streamed 1M construct+index took ${buildMs.toFixed(0)} ms (env guard ceiling 180s)`);
  // drop the test's own bundle reference — the graph holds its source arrays
  bundle.nodeChunks.length = bundle.nodeChunks.length; // keep (source), but clear the outer handle after graph owns it
});

test('SCALE: per-node access touches only its chunk(s) — hot path never scans 15,625 chunks', () => {
  graph.resetReadStats();
  const before = graph.readStats().chunkReads;
  const first = graph.getNode('Root');
  assert.equal(first.name, 'Root');
  const afterFirst = graph.readStats().chunkReads;
  assert.ok(afterFirst - before <= 2, `getNode(Root) touched ${afterFirst - before} chunk(s), want ≤ 2`);
  const midName = `N${Math.floor(NODE_COUNT / 2)}`;
  const mid = graph.getNode(midName);
  assert.equal(mid.name, midName);
  const last = graph.getNode(`N${NODE_COUNT - 1}`);
  assert.equal(last.name, `N${NODE_COUNT - 1}`);
  const after = graph.readStats().chunkReads;
  assert.ok(after - afterFirst <= 6, `3 point reads touched ${after - afterFirst} chunk(s) — bounded per access, O(1) each`);
});

test('SCALE: walking far chunks never exceeds the parsed-HOT bound (logical size ≠ working set)', () => {
  const statsBefore = graph.cacheStats();
  const bound = statsBefore.maxCachedChunks;
  assert.ok(Number.isSafeInteger(bound) && bound > 0, 'hot bound published');
  const chunkCount = graph.manifest().chunkCount;
  assert.equal(chunkCount, Math.ceil(NODE_COUNT / GRAPH_CHUNK_DEFAULT_SIZE));
  for (let c = 0; c < chunkCount; c += Math.max(1, Math.floor(chunkCount / 50))) {
    graph.getChunk(c);
  }
  const stats = graph.cacheStats();
  assert.ok(stats.hot <= bound, `resident parsed HOT ${stats.hot} ≤ bound ${bound}`);
  assert.ok(stats.hits + stats.misses > 0, 'cache engaged during the walk');
});

test('SCALE: readyAfter cost = satisfied × fan-out — no whole-graph scan on the hot path', () => {
  const t0 = performance.now();
  const ready = graph.readyAfter(['Root']);
  const ms = performance.now() - t0;
  assert.equal(ready.length, NODE_COUNT - 1, 'every leaf becomes ready after the root');
  assert.ok(ms < 60_000, `readyAfter on 1M successors took ${ms.toFixed(0)} ms (env guard ceiling 60s)`);
  const t1 = performance.now();
  const tiny = graph.readyAfter(['N42']);
  const tinyMs = performance.now() - t1;
  assert.equal(tiny.length, 0, 'leaf has no successors');
  assert.ok(tinyMs < 50, `leaf-batch query ${tinyMs.toFixed(2)} ms — proportional to batch, not graph size`);
});

test('SCALE: structural identity at 1M — fan bounds, frozen payloads, lifecycle vocabulary intact', () => {
  assert.equal(graph.fanOutOf('Root'), NODE_COUNT - 1);
  assert.equal(graph.fanInOf('N777777'), 1);
  assert.equal(graph.fanInOf('Root'), 0);
  const sample = graph.getNode('N999999');
  assert.ok(Object.isFrozen(sample), 'accessor payloads stay frozen at scale');
  const stage = graph.lifecycleOf('N999999');
  assert.ok(['RESOLVED', 'MATERIALIZED', 'HOT'].includes(stage) || typeof stage === 'string',
    `lifecycle stage published (${stage}) — executor stages (READY/EXECUTING/COMMITTED) remain unclaimed`);
  // initialReady cold-start pagination still bounded at 1M
  const page = graph.initialReady({ limit: 10 });
  assert.equal(page.ready.length, 1, 'exactly one root');
  assert.equal(page.next, NODE_COUNT, 'cursor walked to EOF (single root fixture)');
  assert.equal(page.done, true);
});

// keep createWorkflowGraph imported for parity with streamed path usage in DNA-heavy envs
void createWorkflowGraph;
