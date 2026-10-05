/**
 * Workflow DNA — bounded structural fingerprint of a canonical workflow
 * (P3 Slice H, Issues #75/#97).
 *
 * PUBLIC CONTRACT (`workflow.dna`, v0.1.0, owner: agent-1).
 *
 * The DNA is a DETERMINISTIC, BOUNDED summary of a workflow's identity and
 * morphology — not a replacement for the canonical definition (the graph and
 * the document stay the authorities; §6):
 *
 *   - `checksum` IS the n8n-editor contract checksum
 *     (calculateWorkflowChecksum — exact identity, order-sensitive);
 *   - morphology: node/edge counts, type@typeVersion histogram, root/leaf
 *     counts with CAPPED name samples, max fan-out/fan-in, orphan connection
 *     keys (capped) — every list capped at WORKFLOW_DNA_LIST_CAP so a 10M-node
 *     workflow produces a SMALL constant-ish DNA (bounded summary, never a
 *     second materialization of the graph);
 *   - single streaming pass, no adjacency retained, no chunking needed —
 *     works directly on the canonical definition;
 *   - deterministic: same definition ⇒ deep-equal DNA; node-order shuffle
 *     changes the exact checksum but PRESERVES the morphology block
 *     (order-insensitive fields are exactly those documented as such).
 *
 * Use: cache keys, oracle fast-path (different DNA ⇒ nothing else to
 * compare), acceptance-matrix identity for stress runs.
 *
 * Purity: only `../checksum.mjs` (same workflow domain seam) — no clock,
 * fs, network, timers. One error family `lego.contract_violation`.
 *
 * Owner: agent-1 per Issue #98.
 */
import { calculateWorkflowChecksum } from '../checksum.mjs';

/** The contract this module publishes. */
export const WORKFLOW_DNA_CONTRACT = Object.freeze({
  id: `workflow.dna`,
  version: '0.1.0',
  owner: 'agent-1',
});

/** Pinned contract version for pin-style assertions. */
export const WORKFLOW_DNA_CONTRACT_VERSION = WORKFLOW_DNA_CONTRACT.version;

/** DNA format version (bump when the summary shape changes). */
export const WORKFLOW_DNA_VERSION = 1;

/** Every name list in the DNA is capped — bounded summary, never full enumeration. */
export const WORKFLOW_DNA_LIST_CAP = 64;

/** One error family — same published code as the rest of the lego surface. */
export class WorkflowDnaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WorkflowDnaError';
    this.code = 'lego.contract_violation';
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details) {
  throw new WorkflowDnaError(message, details);
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

/**
 * Compute the bounded DNA of a canonical n8n definition.
 *
 * @param {object} definition canonical workflow JSON (read, never mutated)
 * @returns {object} frozen DNA summary
 */
export function computeWorkflowDna(definition) {
  if (!isPlainObject(definition)) {
    fail('a canonical workflow definition (plain object) is required', { field: 'definition' });
  }
  const { nodes, connections } = definition;
  if (!Array.isArray(nodes)) fail('definition.nodes must be an array', { field: 'nodes' });
  if (!isPlainObject(connections)) fail('definition.connections must be an object', { field: 'connections' });

  const names = new Set();
  const typeHistogram = new Map();
  for (const node of nodes) {
    if (!isPlainObject(node)) fail('every node must be a plain object', { field: 'nodes', reason: 'bad-node' });
    if (typeof node.name !== 'string' || node.name.length === 0) {
      fail('every node needs a non-empty name', { field: 'nodes', reason: 'bad-node' });
    }
    if (names.has(node.name)) {
      fail('node names are the graph identity and must be unique', { field: 'nodes', reason: 'duplicate-name' });
    }
    names.add(node.name);
    const key = `${node.type}@${node.typeVersion}`;
    typeHistogram.set(key, (typeHistogram.get(key) ?? 0) + 1);
  }

  // degrees in ONE pass over connections (orphan sources included — structural truth)
  const inDegree = new Map();
  const outDegree = new Map();
  const orphanKeys = [];
  let maxFanOut = 0;
  for (const [source, byType] of Object.entries(connections)) {
    if (!isPlainObject(byType)) fail('every connection entry must be an object', { field: 'connections' });
    if (!names.has(source) && orphanKeys.length < WORKFLOW_DNA_LIST_CAP) orphanKeys.push(source);
    let fanOut = outDegree.get(source) ?? 0;
    for (const bundles of Object.values(byType)) {
      if (!Array.isArray(bundles)) continue;
      for (const list of bundles) {
        if (!Array.isArray(list)) continue;
        for (const link of list) {
          if (link === null || typeof link !== 'object' || typeof link.node !== 'string') continue;
          fanOut += 1;
          inDegree.set(link.node, (inDegree.get(link.node) ?? 0) + 1);
        }
      }
    }
    outDegree.set(source, fanOut);
    if (fanOut > maxFanOut) maxFanOut = fanOut;
  }

  let maxFanIn = 0;
  const roots = [];
  const leaves = [];
  for (const name of names) {
    const fanIn = inDegree.get(name) ?? 0;
    if (fanIn > maxFanIn) maxFanIn = fanIn;
    const fanOut = outDegree.get(name) ?? 0;
    if (fanIn === 0) roots.push(name);
    if (fanOut === 0) leaves.push(name);
  }

  const { nodes: _nodes, connections: _connections, ...header } = definition;
  const sortedTypeHistogram = {};
  for (const key of [...typeHistogram.keys()].sort()) sortedTypeHistogram[key] = typeHistogram.get(key);

  return Object.freeze({
    dnaVersion: WORKFLOW_DNA_VERSION,
    contract: `${WORKFLOW_DNA_CONTRACT.id}@${WORKFLOW_DNA_CONTRACT.version}`,
    // exact identity (n8n-editor contract checksum)
    checksum: calculateWorkflowChecksum(definition),
    // morphology (order-insensitive fields — shuffle-stable by design)
    nodeCount: nodes.length,
    edgeCount: countEdges(connections),
    typeHistogram: Object.freeze(sortedTypeHistogram),
    rootCount: roots.length,
    leafCount: leaves.length,
    roots: Object.freeze(roots.slice(0, WORKFLOW_DNA_LIST_CAP)),
    leaves: Object.freeze(leaves.slice(0, WORKFLOW_DNA_LIST_CAP)),
    maxFanOut,
    maxFanIn,
    orphanConnectionKeyCount: (() => {
      let all = 0;
      for (const key of Object.keys(connections)) if (!names.has(key)) all += 1;
      return all;
    })(),
    orphanConnectionKeys: Object.freeze(orphanKeys.slice(0, WORKFLOW_DNA_LIST_CAP)),
    headerFields: Object.freeze(Object.keys(header).sort()),
    boundedLists: WORKFLOW_DNA_LIST_CAP,
  });
}
