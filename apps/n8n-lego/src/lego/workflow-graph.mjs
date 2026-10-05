/**
 * Workflow graph — persistent logical graph (P3 Slices A–C, Issues #75/#97).
 *
 * PUBLIC CONTRACT (`workflow.graph`, v1.0.0, owner: agent-1).
 *
 * The canonical workflow definition stays the AUTHORITATIVE source of truth
 * (§6: author/canonical graph → derived representations → execution). This
 * module turns that canonical definition into a CHUNKED, INDEXED, LOSSLESS
 * logical graph whose resident representation is deliberately smaller than
 * "one live JS object per node":
 *
 *   - nodes live as VERBATIM JSON strings, bucketed into fixed-size chunks;
 *   - connections are bucketed by source node into the same chunks (partial
 *     reads address one chunk, never the whole graph);
 *   - the resident index is name → ordinal (an integer), not name → object;
 *   - getChunk / getNode / getOutgoingConnections touch exactly one chunk
 *     (readStats proves it);
 *   - exportBundle / graphFromBundle give the durable logical form (manifest
 *     + chunks) with fail-closed integrity (chunk digest);
 *   - exportDefinition reconstructs the canonical n8n JSON losslessly —
 *     deep-equal roundtrip including orphan connection keys and every
 *     top-level header field — and the manifest checksum stays the
 *     n8n-editor contract checksum (calculateWorkflowChecksum).
 *
 * WHAT THIS IS NOT
 * ----------------
 * No filesystem, no network, no clock, no executor, no optimizer, no second
 * workflow store — n8n-ts WorkflowStore keeps the canonical document; this
 * graph is a DERIVED, disposable, reconstructible representation of it. No
 * artificial node-count cap: logical size is bounded by chunked structure and
 * later slices' resource budgets, never by an arbitrary ceiling (P3
 * anti-pattern 13).
 *
 * Owner: agent-1 (P3 owns workflow graph per Issue #98).
 *
 * SLICE B (indexed edge access): a LAZY reverse index (destination → sources)
 * is built on first `getIncoming` call by reading each edge bucket exactly
 * once, served entirely from memory afterwards (0 chunk reads per hit), and
 * droppable via `releaseReverseIndex` (evict → rematerialize). The reverse
 * index is DERIVED: it is never bundled, never persisted, and connection
 * targets that are not graph nodes (dangling) are never indexed — the
 * canonical connections payload still roundtrips losslessly.
 *
 * SLICE C (materialization control — logical size ≠ resident working set):
 *   - all payload reads go through an internal STORE PORT with two modes:
 *     `memory` (default — raw chunks resident, the Slice A baseline) and
 *     `lazy` (raw chunks load on demand from the immutable source into a
 *     bounded resident window, evicting back to COLD);
 *   - a bounded HOT cache (`maxCachedChunks`, LRU) holds the PARSED payload —
 *     the expensive layer — so peak resident parsed chunks NEVER exceeds the
 *     bound, no matter how large the logical graph is;
 *   - residency per chunk: HOT (parsed resident) / WARM (raw resident in the
 *     store window) / COLD (source only — reloadable), exposed by
 *     `residencyOf`;
 *   - `evictChunk` drops the HOT entry (and the raw window entry when the
 *     port has a cold tier); `cacheStats` reports the bounded counters;
 *   - `GRAPH_NODE_LIFECYCLE` publishes the node stage vocabulary
 *     (DECLARED → INDEXED → RESOLVED → MATERIALIZED → READY → EXECUTING →
 *     COMMITTED → EVICTABLE → EVICTED); `lifecycleOf(name)` maps a node's
 *     CURRENT runtime stage from its chunk's residency — the execution stages
 *     (READY/EXECUTING/COMMITTED) are reserved for the executor slices;
 *   - accessor-returned payloads are FROZEN: the resident form is shared,
 *     immutable state (the canonical document stays authoritative; callers
 *     read, never mutate);
 *   - source-level full reads (exportBundle / exportDefinition / integrity /
 *     nodeNames) deliberately bypass the window — exports are rare by design
 *     and must stay lossless regardless of residency churn.
 */
import { createHash } from 'node:crypto';
import { calculateWorkflowChecksum } from '../checksum.mjs';

/** The contract this module publishes. */
export const WORKFLOW_GRAPH_CONTRACT = Object.freeze({
  id: `workflow.graph`,
  version: '0.1.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const WORKFLOW_GRAPH_CONTRACT_VERSION = WORKFLOW_GRAPH_CONTRACT.version;

/** Nodes per chunk at build time (manifest records the effective size). */
export const GRAPH_CHUNK_DEFAULT_SIZE = 1024;

/** Default bound of the HOT (parsed) chunk cache — Slice C working-set cap. */
export const GRAPH_HOT_CACHE_DEFAULT_CHUNKS = 8;

/** Structural validation bounds — deliberately NO node-count ceiling. */
export const WORKFLOW_GRAPH_LIMITS = Object.freeze({
  maxNameLength: 256,
  maxBundleVersion: 1,
});

/** Bundle wire format version produced by exportBundle. */
export const WORKFLOW_GRAPH_BUNDLE_VERSION = 1;

/**
 * Node lifecycle vocabulary (P3). Stages before READY are observable on the
 * graph today; READY/EXECUTING/COMMITTED belong to the executor slices;
 * EVICTABLE is the internal HOT age-out transition; EVICTED is the explicit
 * `evictChunk` marker (reloadable — lossless by construction).
 */
export const GRAPH_NODE_LIFECYCLE = Object.freeze([
  'DECLARED',
  'INDEXED',
  'RESOLVED',
  'MATERIALIZED',
  'READY',
  'EXECUTING',
  'COMMITTED',
  'EVICTABLE',
  'EVICTED',
]);

/** Chunk residency vocabulary served by `residencyOf`. */
export const GRAPH_RESIDENCY = Object.freeze({
  HOT: 'HOT',
  WARM: 'WARM',
  COLD: 'COLD',
});

/** One error family; the code is published in errors contract 1.2.0 (untouched). */
export class WorkflowGraphError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkflowGraphError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new WorkflowGraphError(message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Count edges across an n8n connections map (all types, all bundles). */
function countEdges(connections) {
  let edges = 0;
  for (const byType of Object.values(connections)) {
    if (!isPlainObject(byType)) continue;
    for (const bundles of Object.values(byType)) {
      if (!Array.isArray(bundles)) continue;
      for (const list of bundles) {
        if (Array.isArray(list)) edges += list.length;
      }
    }
  }
  return edges;
}

function assertName(name, field) {
  if (typeof name !== 'string' || name.length === 0 || name.length > WORKFLOW_GRAPH_LIMITS.maxNameLength) {
    fail(`${field} must be a string of 1..${WORKFLOW_GRAPH_LIMITS.maxNameLength} characters`, { field });
  }
  return name;
}

/** sha256 over the chunked resident form — detects store/bundle corruption. */
function digestChunks(nodeChunks, edgeChunks, headerJson, orphanJson) {
  const hash = createHash('sha256');
  hash.update(headerJson, 'utf8');
  hash.update('\n|orphan|', 'utf8');
  hash.update(orphanJson, 'utf8');
  for (let i = 0; i < nodeChunks.length; i += 1) {
    hash.update('\n|chunk|', 'utf8');
    hash.update(String(i), 'utf8');
    for (const nodeString of nodeChunks[i]) hash.update(nodeString, 'utf8');
    hash.update(edgeChunks[i] ?? '', 'utf8');
  }
  return hash.digest('hex');
}

/** Deep-freeze parsed payloads — the HOT cache serves shared immutable state. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

/**
 * STORE PORT (Slice C, internal): every payload read of the logical graph
 * goes through this seam — never directly at the arrays. Implementations:
 *
 *   - memory (default): raw chunks always resident (WARM floor = the Slice A
 *     baseline footprint); no cold tier (`evict` declines);
 *   - lazy: raw chunks load from the immutable source into a resident window
 *     bounded by the SAME `maxCachedChunks` knob; window misses evict back to
 *     COLD (a future persistence adapter swaps `source` for a file-backed
 *     medium behind the same port — no contract change).
 *
 * Port surface: chunkCount() · readNodeChunk(i) → string[] ·
 * readEdgeChunk(i) → string · isResident(i) → boolean · evict(i) → boolean ·
 * stats() → { resident, loads, evictions }.
 */

function createMemoryStore(source) {
  const count = source.nodeChunks.length;
  return {
    kind: 'memory',
    chunkCount: () => count,
    readNodeChunk: (index) => source.nodeChunks[index],
    readEdgeChunk: (index) => source.edgeChunks[index] ?? '',
    isResident: () => true,
    evict: () => false,
    stats: () => ({ resident: count, loads: 0, evictions: 0 }),
  };
}

function createLazyStore(source, maxWindow) {
  const count = source.nodeChunks.length;
  const windowChunks = new Map(); // chunkIndex → { nodes, edge } (LRU by insertion)
  let loads = 0;
  let evictions = 0;
  const load = (index) => {
    let entry = windowChunks.get(index);
    if (entry === undefined) {
      loads += 1;
      entry = { nodes: source.nodeChunks[index], edge: source.edgeChunks[index] ?? '' };
      windowChunks.set(index, entry);
      while (windowChunks.size > maxWindow) {
        const oldest = windowChunks.keys().next().value;
        windowChunks.delete(oldest);
        evictions += 1;
      }
    } else {
      windowChunks.delete(index);
      windowChunks.set(index, entry); // LRU touch
    }
    return entry;
  };
  return {
    kind: 'lazy',
    chunkCount: () => count,
    readNodeChunk: (index) => load(index).nodes,
    readEdgeChunk: (index) => load(index).edge,
    isResident: (index) => windowChunks.has(index),
    evict: (index) => {
      const had = windowChunks.delete(index);
      if (had) evictions += 1;
      return had;
    },
    stats: () => ({ resident: windowChunks.size, loads, evictions }),
  };
}

/** Resolve + validate materialization options (fail-closed, one error family). */
function resolveMaterializationOptions(options) {
  const maxCachedChunks = options.maxCachedChunks ?? GRAPH_HOT_CACHE_DEFAULT_CHUNKS;
  if (!Number.isSafeInteger(maxCachedChunks) || maxCachedChunks < 0 || maxCachedChunks > 65536) {
    fail('maxCachedChunks must be a safe integer in 0..65536', { field: 'maxCachedChunks' });
  }
  if ('lazy' in options && typeof options.lazy !== 'boolean') {
    fail('lazy must be a boolean', { field: 'lazy' });
  }
  return { maxCachedChunks, lazy: options.lazy === true };
}

class LogicalWorkflowGraph {
  #manifest;
  #source;
  #ordinals;
  #headerJson;
  #orphanJson;
  #incoming = null; // Map<dest, [{source, type, index}]> — lazy, derived, droppable
  #reads = { chunkReads: 0 };
  #store;
  #hot = new Map(); // chunkIndex → { nodes: frozen[], bucket: frozen|null } (LRU)
  #maxHot;
  #cache = { hits: 0, misses: 0, evictions: 0 };
  #evicted = new Set(); // chunks dropped by evictChunk — EVICTED until re-read

  constructor(parts) {
    this.#manifest = Object.freeze({ ...parts.manifest });
    this.#source = { nodeChunks: parts.nodeChunks, edgeChunks: parts.edgeChunks };
    this.#ordinals = parts.ordinals;
    this.#headerJson = parts.headerJson;
    this.#orphanJson = parts.orphanJson;
    this.#maxHot = parts.maxCachedChunks;
    this.#store = parts.store;
  }

  manifest() {
    return this.#manifest;
  }

  chunkCount() {
    return this.#source.nodeChunks.length;
  }

  nodeCount() {
    return this.#manifest.nodeCount;
  }

  edgeCount() {
    return this.#manifest.edgeCount;
  }

  /** Observability: logical chunk reads served (tests, later resource budgets). */
  readStats() {
    return { ...this.#reads };
  }

  resetReadStats() {
    this.#reads.chunkReads = 0;
  }

  /** Observability: bounded-cache + store-port counters (Slice C). */
  cacheStats() {
    const store = this.#store.stats();
    return Object.freeze({
      maxCachedChunks: this.#maxHot,
      hot: this.#hot.size,
      hits: this.#cache.hits,
      misses: this.#cache.misses,
      evictions: this.#cache.evictions,
      storeKind: this.#store.kind,
      storeResident: store.resident,
      storeLoads: store.loads,
      storeEvictions: store.evictions,
    });
  }

  /**
   * Materialize one chunk through the store port into the bounded HOT cache.
   * Returns the shared frozen entry { nodes, bucket }. Logical chunk reads
   * are counted by the accessors; this layer counts hits/misses/evictions.
   */
  #materialize(chunkIndex) {
    const existing = this.#hot.get(chunkIndex);
    if (existing !== undefined) {
      this.#cache.hits += 1;
      this.#hot.delete(chunkIndex);
      this.#hot.set(chunkIndex, existing); // LRU touch
      return existing;
    }
    this.#cache.misses += 1;
    const rawNodes = this.#store.readNodeChunk(chunkIndex);
    const rawEdge = this.#store.readEdgeChunk(chunkIndex);
    this.#evicted.delete(chunkIndex); // payload re-read → residency truth refreshes
    const nodes = Object.freeze(rawNodes.map((nodeString) => deepFreeze(JSON.parse(nodeString))));
    const bucket = rawEdge ? deepFreeze(JSON.parse(rawEdge)) : null;
    const entry = { nodes, bucket };
    if (this.#maxHot > 0) {
      this.#hot.set(chunkIndex, entry);
      while (this.#hot.size > this.#maxHot) {
        const oldest = this.#hot.keys().next().value;
        this.#hot.delete(oldest);
        this.#cache.evictions += 1; // HOT age-out (EVICTABLE transition, internal)
      }
    }
    return entry;
  }

  #assertChunkIndex(chunkIndex) {
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= this.#source.nodeChunks.length) {
      fail('chunk index out of range', { field: 'chunkIndex', reason: 'out-of-range' });
    }
    return chunkIndex;
  }

  /** Chunk index holding a node's payload (addressing: floor(ordinal/size)). */
  #chunkOfOrdinal(ordinal) {
    return Math.floor(ordinal / this.#manifest.chunkSize);
  }

  /** Partial read: exactly one chunk's nodes, parsed (frozen, cached). */
  getChunk(chunkIndex) {
    this.#assertChunkIndex(chunkIndex);
    this.#reads.chunkReads += 1;
    return this.#materialize(chunkIndex).nodes;
  }

  /** Indexed node access: Map lookup → one chunk → serve one frozen node. */
  getNode(name) {
    const ordinal = this.#ordinals.get(name);
    if (ordinal === undefined) {
      fail('node not found in the logical graph', { field: 'name', reason: 'unknown-node' });
    }
    this.#reads.chunkReads += 1;
    const entry = this.#materialize(this.#chunkOfOrdinal(ordinal));
    return entry.nodes[ordinal % this.#manifest.chunkSize];
  }

  hasNode(name) {
    return this.#ordinals.has(name);
  }

  /**
   * Names in canonical ordinal order, yielded chunk by chunk — a SOURCE-level
   * streaming walk: no cache interaction, bounded peak memory by design.
   */
  *nodeNames() {
    for (const chunk of this.#source.nodeChunks) {
      for (const nodeString of chunk) yield JSON.parse(nodeString).name;
    }
  }

  /** Connections bucketed for sourceName, materialized from its chunk only. */
  getOutgoingConnections(sourceName) {
    const ordinal = this.#ordinals.get(sourceName);
    if (ordinal === undefined) {
      fail('node not found in the logical graph', { field: 'name', reason: 'unknown-node' });
    }
    this.#reads.chunkReads += 1;
    const entry = this.#materialize(this.#chunkOfOrdinal(ordinal));
    return entry.bucket === null ? {} : (entry.bucket[sourceName] ?? {});
  }

  /**
   * Residency of one chunk: HOT = parsed resident in the bounded cache,
   * WARM = raw resident in the store window, COLD = source only.
   */
  residencyOf(chunkIndex) {
    this.#assertChunkIndex(chunkIndex);
    if (this.#hot.has(chunkIndex)) return GRAPH_RESIDENCY.HOT;
    return this.#store.isResident(chunkIndex) ? GRAPH_RESIDENCY.WARM : GRAPH_RESIDENCY.COLD;
  }

  /**
   * Explicit eviction: drop the HOT entry (and the raw window entry when the
   * port has a cold tier). Returns whether anything was dropped. Reloadable —
   * lossless by construction.
   */
  evictChunk(chunkIndex) {
    this.#assertChunkIndex(chunkIndex);
    const hadHot = this.#hot.delete(chunkIndex);
    if (hadHot) this.#cache.evictions += 1;
    const droppedStore = this.#store.evict(chunkIndex);
    const dropped = hadHot || droppedStore;
    if (dropped) this.#evicted.add(chunkIndex);
    return dropped;
  }

  /**
   * Current lifecycle stage of a node, derived from its chunk's residency
   * (see GRAPH_NODE_LIFECYCLE): HOT → MATERIALIZED; re-read payload →
   * RESOLVED (warm) / INDEXED (cold, never evicted); explicit evict →
   * EVICTED until the next payload read. Execution stages are reserved.
   */
  lifecycleOf(name) {
    const ordinal = this.#ordinals.get(name);
    if (ordinal === undefined) {
      fail('node not found in the logical graph', { field: 'name', reason: 'unknown-node' });
    }
    const chunkIndex = this.#chunkOfOrdinal(ordinal);
    if (this.residencyOf(chunkIndex) === GRAPH_RESIDENCY.HOT) return 'MATERIALIZED';
    if (this.#evicted.has(chunkIndex)) return 'EVICTED';
    return this.residencyOf(chunkIndex) === GRAPH_RESIDENCY.WARM ? 'RESOLVED' : 'INDEXED';
  }

  /**
   * Tier residency summary over ALL chunks (observability for hot/warm/cold
   * policy — Issue #79 "evict cold/warm representations" needs the census).
   * Returns frozen {HOT, WARM, COLD, chunkCount, reverseIndexResident}.
   */
  residencySummary() {
    let hot = 0;
    let warm = 0;
    let cold = 0;
    for (let chunkIndex = 0; chunkIndex < this.#source.nodeChunks.length; chunkIndex += 1) {
      const residency = this.residencyOf(chunkIndex);
      if (residency === GRAPH_RESIDENCY.HOT) hot += 1;
      else if (residency === GRAPH_RESIDENCY.WARM) warm += 1;
      else cold += 1;
    }
    return Object.freeze({
      HOT: hot,
      WARM: warm,
      COLD: cold,
      chunkCount: this.#source.nodeChunks.length,
      reverseIndexResident: this.#incoming !== null,
    });
  }

  /**
   * Memory-pressure relief (Issue #79 step 3 — "evict cold/warm representations",
   * Slice G tier policy): demote the OLDEST HOT entries down to
   * `targetHotChunks` (explicit release → EVICTED marker, raw stays WARM on
   * the memory port / window untouched on the lazy port) and optionally drop
   * the derived reverse index. Defaults = full relief (HOT → 0, index off).
   * Reloadable — lossless by construction.
   */
  applyPressure(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      fail('pressure options must be a plain object', { field: 'options' });
    }
    const targetHotChunks = options.targetHotChunks ?? 0;
    if (!Number.isSafeInteger(targetHotChunks) || targetHotChunks < 0 || targetHotChunks > this.#maxHot) {
      fail(`targetHotChunks must be a safe integer in 0..${this.#maxHot}`, { field: 'targetHotChunks' });
    }
    if ('releaseReverseIndex' in options && typeof options.releaseReverseIndex !== 'boolean') {
      fail('releaseReverseIndex must be a boolean', { field: 'releaseReverseIndex' });
    }
    const releaseIndex = options.releaseReverseIndex ?? true;
    const hotBefore = this.#hot.size;
    let released = 0;
    while (this.#hot.size > targetHotChunks) {
      const oldest = this.#hot.keys().next().value;
      this.#hot.delete(oldest);
      this.#cache.evictions += 1;
      this.#evicted.add(oldest); // explicit policy release — EVICTED until re-read
      released += 1;
    }
    const reverseIndexReleased = releaseIndex ? this.releaseReverseIndex() : false;
    return Object.freeze({
      hotBefore,
      hotAfter: this.#hot.size,
      released,
      reverseIndexReleased,
      targetHotChunks,
    });
  }

  /**
   * Execution-as-query (P3 Slice I): fan-out bound of a node — how many
   * connection links it declares (Issue #75 #3 fan-out limits need the number).
   */
  fanOutOf(name) {
    const bucket = this.getOutgoingConnections(name); // identity check + one-chunk read
    let links = 0;
    for (const outputs of Object.values(bucket)) { // bucket: { [type]: [ [links per output] ] }
      if (!Array.isArray(outputs)) continue;
      for (const linksOfOutput of outputs) {
        if (Array.isArray(linksOfOutput)) links += linksOfOutput.length;
      }
    }
    return links;
  }

  /**
   * Execution-as-query: fan-in bound — indexed incoming edges (dangling
   * sources are not indexed and never block; bounded fan-in coordination,
   * Issue #75 #3). Builds the lazy reverse index once, O(1) after.
   */
  fanInOf(name) {
    return this.getIncoming(name).length;
  }

  /**
   * Cold-start ready query, PAGINATED so discovery never materializes the
   * whole ready set: walk ordinals from `fromOrdinal`, collect up to `limit`
   * nodes with indexed in-degree 0 (roots), return a FROZEN
   * `{ready, next, done}` page. Stateless — the graph owns no execution
   * state; the caller owns cursors. Overall O(nodeCount) once across pages,
   * O(page) per call; the incremental hot path is `readyAfter`.
   */
  initialReady({ limit, fromOrdinal = 0 } = {}) {
    if (limit === undefined || !Number.isSafeInteger(limit) || limit < 1 || limit > this.#manifest.nodeCount) {
      fail(`limit must be a safe integer in 1..${this.#manifest.nodeCount}`, { field: 'limit' });
    }
    if (!Number.isSafeInteger(fromOrdinal) || fromOrdinal < 0 || fromOrdinal > this.#manifest.nodeCount) {
      fail(`fromOrdinal must be a safe integer in 0..${this.#manifest.nodeCount}`, { field: 'fromOrdinal' });
    }
    const ready = [];
    let cursor = fromOrdinal;
    while (cursor < this.#manifest.nodeCount && ready.length < limit) {
      this.#reads.chunkReads += 1;
      const entry = this.#materialize(this.#chunkOfOrdinal(cursor));
      const name = entry.nodes[cursor % this.#manifest.chunkSize].name;
      if (this.getIncoming(name).length === 0) ready.push(name);
      cursor += 1;
    }
    return Object.freeze({
      ready: Object.freeze(ready),
      next: cursor,
      done: cursor >= this.#manifest.nodeCount,
    });
  }

  /**
   * Incremental ready query (#75 #3 — NO whole-graph scan): among the
   * SUCCESSORS of `satisfied`, those whose ALL indexed predecessors are
   * satisfied (and which are not themselves satisfied). `satisfied` = the
   * caller's FULL current satisfied set; the graph stays stateless
   * (execution-as-query). Cost is bounded by |satisfied| × fan-out — the
   * caller's batch size carries backpressure into query cost (Slice D
   * linkage). Results in canonical ordinal order, frozen (accessor contract).
   */
  readyAfter(satisfied) {
    if (typeof satisfied === 'string' || satisfied === null || satisfied === undefined
      || typeof satisfied[Symbol.iterator] !== 'function') {
      fail('satisfied must be an iterable of node names', { field: 'satisfied' });
    }
    const satisfiedSet = new Set();
    for (const name of satisfied) {
      if (typeof name !== 'string' || !this.#ordinals.has(name)) {
        fail('satisfied must contain only graph node names', { field: 'satisfied', reason: 'unknown-node' });
      }
      satisfiedSet.add(name);
    }
    const candidates = new Set();
    for (const name of satisfiedSet) {
      const bucket = this.getOutgoingConnections(name);
      for (const outputs of Object.values(bucket)) { // { [type]: [ [links per output] ] }
        if (!Array.isArray(outputs)) continue;
        for (const linksOfOutput of outputs) {
          if (!Array.isArray(linksOfOutput)) continue;
          for (const link of linksOfOutput) {
            if (link === null || typeof link !== 'object') continue;
            const target = link.node;
            if (typeof target !== 'string' || !this.#ordinals.has(target)) continue; // dangling never runs
            if (satisfiedSet.has(target)) continue;
            candidates.add(target);
          }
        }
      }
    }
    const ready = [];
    const ordered = [...candidates].sort((a, b) => this.#ordinals.get(a) - this.#ordinals.get(b));
    for (const name of ordered) {
      let allSatisfied = true;
      for (const row of this.getIncoming(name)) {
        if (!satisfiedSet.has(row.source)) {
          allSatisfied = false;
          break;
        }
      }
      if (allSatisfied) ready.push(name);
    }
    return Object.freeze(ready);
  }

  /** Has the lazy reverse edge index been materialized? */
  hasReverseIndex() {
    return this.#incoming !== null;
  }

  /** Drop the derived reverse index (eviction); next getIncoming rematerializes it. */
  releaseReverseIndex() {
    const had = this.#incoming !== null;
    this.#incoming = null;
    return had;
  }

  #buildIncoming() {
    const incoming = new Map();
    const edgeChunks = this.#source.edgeChunks;
    for (let chunkIndex = 0; chunkIndex < edgeChunks.length; chunkIndex += 1) {
      const edgeChunk = this.#store.readEdgeChunk(chunkIndex);
      this.#evicted.delete(chunkIndex); // store read refreshes residency truth
      if (!edgeChunk) continue;
      this.#reads.chunkReads += 1; // one edge-bucket read per non-empty bucket
      const bucket = JSON.parse(edgeChunk);
      for (const [source, byType] of Object.entries(bucket)) {
        if (!isPlainObject(byType)) continue;
        for (const [type, bundles] of Object.entries(byType)) {
          if (!Array.isArray(bundles)) continue;
          for (let index = 0; index < bundles.length; index += 1) {
            const list = bundles[index];
            if (!Array.isArray(list)) continue;
            for (const entry of list) {
              const dest = entry && typeof entry === 'object' ? entry.node : null;
              if (typeof dest !== 'string' || !this.#ordinals.has(dest)) continue; // dangling = not indexed
              const row = incoming.get(dest) ?? [];
              row.push(Object.freeze({ source, type, index }));
              incoming.set(dest, row);
            }
          }
        }
      }
    }
    for (const row of incoming.values()) Object.freeze(row);
    this.#incoming = incoming;
  }

  /**
   * Indexed reverse-edge lookup: incoming connections for a real graph node.
   * First call materializes the index (one read per edge bucket); later calls
   * are pure index hits (0 chunk reads). Order is deterministic (chunk order,
   * then declaration order).
   */
  getIncoming(name) {
    if (!this.#ordinals.has(name)) {
      fail('node not found in the logical graph', { field: 'name', reason: 'unknown-node' });
    }
    if (this.#incoming === null) this.#buildIncoming();
    const rows = this.#incoming.get(name);
    return rows === undefined ? Object.freeze([]) : rows;
  }

  /**
   * Recompute the SOURCE digest chunk-by-chunk (bounded peak memory) — the
   * immutable source of truth, independent of residency churn.
   */
  integrity() {
    const actual = digestChunks(
      this.#source.nodeChunks,
      this.#source.edgeChunks,
      this.#headerJson,
      this.#orphanJson,
    );
    return Object.freeze({
      ok: actual === this.#manifest.chunkDigest,
      expected: this.#manifest.chunkDigest,
      actual,
    });
  }

  /**
   * Canonical recovery: rebuild the full n8n definition, deep-equal to the
   * input that produced it (header fields + nodes + connections, orphans
   * included). A deliberate SOURCE-level FULL read — exports are rare by
   * design and must stay lossless regardless of cache/window state.
   */
  exportDefinition() {
    const header = JSON.parse(this.#headerJson);
    const nodes = [];
    for (const chunk of this.#source.nodeChunks) {
      for (const nodeString of chunk) nodes.push(JSON.parse(nodeString));
    }
    const connections = JSON.parse(this.#orphanJson);
    for (const edgeChunk of this.#source.edgeChunks) {
      if (!edgeChunk) continue;
      const bucket = JSON.parse(edgeChunk);
      for (const [sourceName, value] of Object.entries(bucket)) connections[sourceName] = value;
    }
    return { ...header, nodes, connections };
  }

  /** Durable logical form: manifest + chunk strings (+ header/orphans). */
  exportBundle() {
    return {
      bundleVersion: WORKFLOW_GRAPH_BUNDLE_VERSION,
      manifest: { ...this.#manifest },
      headerJson: this.#headerJson,
      orphanJson: this.#orphanJson,
      nodeChunks: this.#source.nodeChunks.map((chunk) => [...chunk]),
      edgeChunks: [...this.#source.edgeChunks],
    };
  }
}

/**
 * Build the persistent logical graph from a canonical n8n definition.
 * The input is read, never mutated; a later export is deep-equal to it.
 *
 * @param {object} definition canonical n8n workflow JSON
 * @param {{chunkSize?: number, maxCachedChunks?: number, lazy?: boolean}} [options]
 *   - maxCachedChunks: bound of the HOT (parsed) chunk cache AND the lazy
 *     store's raw resident window (0 disables the HOT layer; default
 *     GRAPH_HOT_CACHE_DEFAULT_CHUNKS);
 *   - lazy: use the cold-capable store port (loads on demand, COLD tier
 *     reachable; default false = memory port, Slice A baseline behaviour).
 * @returns {LogicalWorkflowGraph}
 */
export function createWorkflowGraph(definition, options = {}) {
  if (!isPlainObject(definition)) {
    fail('a canonical workflow definition (plain object) is required', { field: 'definition' });
  }
  const { nodes, connections } = definition;
  if (!Array.isArray(nodes)) fail('definition.nodes must be an array', { field: 'nodes' });
  if (!isPlainObject(connections)) fail('definition.connections must be an object', { field: 'connections' });
  const chunkSize = options.chunkSize ?? GRAPH_CHUNK_DEFAULT_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 65536) {
    fail('chunkSize must be a safe integer in 1..65536', { field: 'chunkSize' });
  }
  const materialization = resolveMaterializationOptions(options);

  const ordinals = new Map();
  const nodeChunks = [];
  const edgeBuckets = [];
  let currentChunk = [];
  let currentEdges = {};
  const flush = () => {
    nodeChunks.push(currentChunk);
    edgeBuckets.push(Object.keys(currentEdges).length > 0 ? JSON.stringify(currentEdges) : '');
    currentChunk = [];
    currentEdges = {};
  };
  for (let ordinal = 0; ordinal < nodes.length; ordinal += 1) {
    const node = nodes[ordinal];
    if (!isPlainObject(node)) fail('every node must be a plain object', { field: 'nodes', reason: 'bad-node' });
    const name = assertName(node.name, `node.name`);
    if (ordinals.has(name)) {
      fail('node names are the graph identity and must be unique', { field: `node.name`, reason: 'duplicate-name' });
    }
    ordinals.set(name, ordinal);
    currentChunk.push(JSON.stringify(node));
    if (Object.hasOwn(connections, name)) currentEdges[name] = connections[name];
    if (currentChunk.length === chunkSize) flush();
  }
  if (currentChunk.length > 0 || Object.keys(currentEdges).length > 0) flush();

  const { nodes: _nodes, connections: _connections, ...header } = definition;
  const headerJson = JSON.stringify(header);
  const orphan = {};
  for (const key of Object.keys(connections)) if (!ordinals.has(key)) orphan[key] = connections[key];
  const orphanJson = JSON.stringify(orphan);

  const chunkDigest = digestChunks(nodeChunks, edgeBuckets, headerJson, orphanJson);
  const manifest = {
    contract: `${WORKFLOW_GRAPH_CONTRACT.id}@${WORKFLOW_GRAPH_CONTRACT.version}`,
    bundleVersion: WORKFLOW_GRAPH_BUNDLE_VERSION,
    checksum: calculateWorkflowChecksum(definition),
    chunkDigest,
    nodeCount: nodes.length,
    edgeCount: countEdges(connections),
    chunkCount: nodeChunks.length,
    chunkSize,
    addressing: 'ordinal:name→chunk=floor(o/size),offset=o%size',
    nodesField: 'nodes',
    canonical: true,
  };
  const source = { nodeChunks, edgeChunks: edgeBuckets };
  const store = materialization.lazy
    ? createLazyStore(source, materialization.maxCachedChunks)
    : createMemoryStore(source);
  return new LogicalWorkflowGraph({
    manifest,
    nodeChunks,
    edgeChunks: edgeBuckets,
    ordinals,
    headerJson,
    orphanJson,
    maxCachedChunks: materialization.maxCachedChunks,
    store,
  });
}

/**
 * Rebuild a graph from its durable bundle. Fail-closed: the bundle's chunk
 * digest must recompute exactly, or the bundle is refused.
 *
 * @param {object} bundle exportBundle() output
 * @param {{maxCachedChunks?: number, lazy?: boolean}} [options] same
 *   materialization options as createWorkflowGraph.
 * @returns {LogicalWorkflowGraph}
 */
export function graphFromBundle(bundle, options = {}) {
  if (!isPlainObject(bundle)) fail('a graph bundle (plain object) is required', { field: 'bundle' });
  if (bundle.bundleVersion !== WORKFLOW_GRAPH_BUNDLE_VERSION) {
    fail('unsupported graph bundle version', { field: 'bundleVersion', reason: 'unsupported-version' });
  }
  const { manifest, headerJson, orphanJson, nodeChunks, edgeChunks } = bundle;
  if (!isPlainObject(manifest)) fail('bundle.manifest is required', { field: 'manifest' });
  if (typeof headerJson !== 'string' || typeof orphanJson !== 'string') {
    fail('bundle header/orphan fields must be JSON strings', { field: 'headerJson' });
  }
  if (!Array.isArray(nodeChunks) || !Array.isArray(edgeChunks) || nodeChunks.length !== edgeChunks.length) {
    fail('bundle chunk arrays must exist and have equal length', { field: 'nodeChunks' });
  }
  const recomputed = digestChunks(nodeChunks, edgeChunks, headerJson, orphanJson);
  if (recomputed !== manifest.chunkDigest) {
    fail('bundle integrity check failed — chunk digest does not match the manifest', {
      field: 'chunkDigest',
      reason: 'integrity-mismatch',
    });
  }
  const ordinals = new Map();
  let ordinal = 0;
  for (const chunk of nodeChunks) {
    if (!Array.isArray(chunk)) fail('every node chunk must be an array of JSON strings', { field: 'nodeChunks' });
    for (const nodeString of chunk) {
      const node = JSON.parse(nodeString);
      ordinals.set(assertName(node.name, `node.name`), ordinal);
      ordinal += 1;
    }
  }
  if (ordinal !== manifest.nodeCount) {
    fail('bundle node count does not match its manifest', { field: 'nodeCount', reason: 'count-mismatch' });
  }
  const materialization = resolveMaterializationOptions(options);
  const source = { nodeChunks, edgeChunks };
  const store = materialization.lazy
    ? createLazyStore(source, materialization.maxCachedChunks)
    : createMemoryStore(source);
  return new LogicalWorkflowGraph({
    manifest: { ...manifest },
    nodeChunks,
    edgeChunks,
    ordinals,
    headerJson,
    orphanJson,
    maxCachedChunks: materialization.maxCachedChunks,
    store,
  });
}
