/** P9.13 failure correlation compiler. Product owner agent-6; implementation
 * delegate Agent 4 (Issue #101). Builds a bounded causal/correlation graph from
 * failure events + edges: four cause kinds (OBSERVED_CAUSE / INFERRED_CAUSE /
 * CORRELATED_WITH / UNKNOWN), evidence refs mandatory where causality is claimed,
 * confidence+source mandatory on inference, correlation never promoted to cause,
 * unknown roots reported honestly, cycles detected without infinite expansion,
 * secret-shaped evidence rejected at the boundary. No I/O, no clock, no
 * workflow import; same inputs -> same compiled graph bytes.
 */
import { containsSecretShape } from './telemetry-redaction.mjs';

export const FAILURE_CORR_CONTRACT = Object.freeze({
  id: 'observability.failure-correlation', version: '1.0.0', owner: 'agent-6',
});
export const FAILURE_CORR_SCHEMA_VERSION = '1.0.0';
export const FAILURE_CORR_CAUSE_KINDS = Object.freeze([
  'OBSERVED_CAUSE', 'INFERRED_CAUSE', 'CORRELATED_WITH', 'UNKNOWN',
]);
export const FAILURE_CORR_NOTES = Object.freeze([
  'correlation-only-not-promoted',
  'no-inbound-causal-claims',
  'inferred-not-observed',
  'cycle-truncated',
]);
export const FAILURE_CORR_LIMITS = Object.freeze({
  identifierBytes: 128,
  maxEvents: 128,
  maxEdges: 256,
  maxEvidencePerEdge: 16,
  maxEvidencePerEvent: 16,
  maxExpansionDepth: 64,
  maxPathNodes: 64,
  minConfidence: 0,
  maxConfidence: 1,
});

const SPEC_KEYS = Object.freeze(['events', 'edges', 'rootId']);
const EVENT_KEYS = Object.freeze(['id', 'kind', 'evidence']);
const EDGE_KEYS = Object.freeze(['from', 'to', 'kind', 'evidence', 'confidence', 'source']);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedId(value) {
  if (typeof value !== 'string' || value.length === 0 ||
      value.length > FAILURE_CORR_LIMITS.identifierBytes) return null;
  if (containsSecretShape(value)) return null;
  if (/\b(?:bearer|basic)\s+\S/i.test(value)) return null;
  if (/\b(?:password|secret|token|api[-_]?key)\s*[:=]\s*\S/i.test(value)) return null;
  return value;
}

function normalizeEvidenceList(list, max) {
  if (list === undefined) return { ok: true, value: [] };
  if (!Array.isArray(list) || list.length === 0 || list.length > max) return { ok: false, value: null };
  const out = [];
  for (const raw of list) {
    const id = boundedId(raw);
    if (id === null) return { ok: false, value: null };
    out.push(id);
  }
  return { ok: true, value: out };
}

function normalizeEvent(raw) {
  if (!isPlain(raw)) return null;
  if (Reflect.ownKeys(raw).some(k => !EVENT_KEYS.includes(k))) return null;
  const id = boundedId(raw.id);
  const kind = boundedId(raw.kind);
  if (id === null || kind === null) return null;
  const ev = normalizeEvidenceList(raw.evidence, FAILURE_CORR_LIMITS.maxEvidencePerEvent);
  if (!ev.ok) return null;
  const out = { id, kind };
  if (ev.value.length > 0) out.evidence = ev.value;
  return out;
}

function normalizeEdge(raw) {
  if (!isPlain(raw)) return null;
  if (Reflect.ownKeys(raw).some(k => !EDGE_KEYS.includes(k))) return null;
  const from = boundedId(raw.from);
  const to = boundedId(raw.to);
  if (from === null || to === null) return null;
  if (!FAILURE_CORR_CAUSE_KINDS.includes(raw.kind)) return null;
  const ev = normalizeEvidenceList(raw.evidence, FAILURE_CORR_LIMITS.maxEvidencePerEdge);
  if (!ev.ok) return null;
  const out = { from, to, kind: raw.kind };
  if (ev.value.length > 0) out.evidence = ev.value;

  if (raw.kind === 'OBSERVED_CAUSE' || raw.kind === 'CORRELATED_WITH') {
    // Causal / correlational claims require at least one evidence ref.
    if (out.evidence === undefined || out.evidence.length === 0) return null;
  }
  if (raw.kind === 'INFERRED_CAUSE') {
    if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) ||
        raw.confidence < FAILURE_CORR_LIMITS.minConfidence ||
        raw.confidence > FAILURE_CORR_LIMITS.maxConfidence) return null;
    const source = boundedId(raw.source);
    if (source === null) return null;
    out.confidence = raw.confidence;
    out.source = source;
  } else if (raw.kind === 'CORRELATED_WITH') {
    // Optional annotations never promote correlation to causality.
    if (raw.confidence !== undefined) {
      if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) ||
          raw.confidence < FAILURE_CORR_LIMITS.minConfidence ||
          raw.confidence > FAILURE_CORR_LIMITS.maxConfidence) return null;
      out.confidence = raw.confidence;
    }
    if (raw.source !== undefined) {
      const source = boundedId(raw.source);
      if (source === null) return null;
      out.source = source;
    }
  } else if (raw.confidence !== undefined || raw.source !== undefined) {
    return null;
  }
  return out;
}

/** Compile a failure-correlation graph. Fail-closed: invalid shape -> null.
 * Fixture `expect` annotations must be stripped by the caller (test helper). */
export function compileFailureCorrelation(spec) {
  if (!isPlain(spec)) return null;
  if (Reflect.ownKeys(spec).some(k => !SPEC_KEYS.includes(k))) return null;
  if (!Array.isArray(spec.events) || spec.events.length === 0 ||
      spec.events.length > FAILURE_CORR_LIMITS.maxEvents) return null;
  if (!Array.isArray(spec.edges) || spec.edges.length > FAILURE_CORR_LIMITS.maxEdges) return null;
  const rootId = boundedId(spec.rootId);
  if (rootId === null) return null;

  const events = [];
  const ids = new Set();
  for (const raw of spec.events) {
    const ev = normalizeEvent(raw);
    if (ev === null || ids.has(ev.id)) return null;
    ids.add(ev.id);
    events.push(ev);
  }
  if (!ids.has(rootId)) return null;

  const edges = [];
  for (const raw of spec.edges) {
    const edge = normalizeEdge(raw);
    if (edge === null) return null;
    if (!ids.has(edge.from) || !ids.has(edge.to)) return null;
    if (edge.from === edge.to) return null;
    edges.push(edge);
  }

  const inbound = new Map();
  const outbound = new Map();
  for (const id of ids) { inbound.set(id, []); outbound.set(id, []); }
  for (const edge of edges) {
    inbound.get(edge.to).push(edge);
    outbound.get(edge.from).push(edge);
  }

  const evidenceMissing = [];
  if (!events.some(e => e.evidence !== undefined)) evidenceMissing.push('eventEvidence');
  if (edges.length === 0) evidenceMissing.push('causalEdges');

  return Object.freeze({
    schemaVersion: FAILURE_CORR_SCHEMA_VERSION,
    contract: FAILURE_CORR_CONTRACT,
    events: Object.freeze(events),
    edges: Object.freeze(edges),
    rootId,
    inbound,
    outbound,
    evidenceMissing: Object.freeze(evidenceMissing),
  });
}

/** Classify the root failure's inbound claim. Correlation is never promoted;
 * absence of causal claims -> UNKNOWN. Inference carries confidence/source. */
export function classifyRootCause(graph, rootId = undefined) {
  if (graph === null || typeof graph !== 'object') return null;
  const id = rootId === undefined ? graph.rootId : boundedId(rootId);
  if (id === null || !graph.inbound || !graph.inbound.has(id)) return null;
  const inbound = graph.inbound.get(id);
  const observed = inbound.filter(e => e.kind === 'OBSERVED_CAUSE');
  const inferred = inbound.filter(e => e.kind === 'INFERRED_CAUSE');
  const correlated = inbound.filter(e => e.kind === 'CORRELATED_WITH');

  if (observed.length > 0) {
    return Object.freeze({ rootKind: 'OBSERVED_CAUSE' });
  }
  if (inferred.length > 0) {
    let best = inferred[0];
    for (const e of inferred) {
      if (e.confidence > best.confidence) best = e;
    }
    return Object.freeze({
      rootKind: 'INFERRED_CAUSE',
      confidence: best.confidence,
      source: best.source,
      note: 'inferred-not-observed',
    });
  }
  if (correlated.length > 0) {
    return Object.freeze({ rootKind: 'UNKNOWN', note: 'correlation-only-not-promoted' });
  }
  return Object.freeze({ rootKind: 'UNKNOWN', note: 'no-inbound-causal-claims' });
}

/** Walk inbound causal ancestry from root with a hard depth bound. Visits each
 * node at most once so cycles terminate with `cycleDetected: true`. */
export function expandCausalChain(graph, rootId = undefined) {
  if (graph === null || typeof graph !== 'object') return null;
  const start = rootId === undefined ? graph.rootId : boundedId(rootId);
  if (start === null || !graph.inbound || !graph.inbound.has(start)) return null;

  const visited = new Set([start]);
  const path = [start];
  let frontier = [start];
  let cycleDetected = false;
  let depth = 0;

  while (frontier.length > 0 && depth < FAILURE_CORR_LIMITS.maxExpansionDepth) {
    const next = [];
    let capped = false;
    for (const nodeId of frontier) {
      for (const edge of graph.inbound.get(nodeId)) {
        const parent = edge.from;
        if (visited.has(parent)) {
          cycleDetected = true;
          continue;
        }
        if (path.length >= FAILURE_CORR_LIMITS.maxPathNodes) {
          capped = true;
          break;
        }
        visited.add(parent);
        path.push(parent);
        next.push(parent);
      }
      if (capped) break;
    }
    frontier = capped ? [] : next;
    depth += 1;
    if (next.length === 0) break;
  }

  return Object.freeze({
    rootId: start,
    path: Object.freeze(path),
    pathLength: path.length - 1,
    cycleDetected,
    terminates: true,
  });
}

/** Attach (or re-validate) evidence refs on a compiled graph edge set. Returns
 * a new frozen edge list with evidence attached; null if any ref is unsafe. */
export function attachEvidence(graph, evidenceByEdgeKey) {
  if (graph === null || typeof graph !== 'object') return null;
  if (!isPlain(evidenceByEdgeKey)) return null;
  const out = [];
  for (const edge of graph.edges) {
    const key = String(edge.from) + String(edge.to) + String(edge.kind);
    const extra = evidenceByEdgeKey[key];
    if (extra === undefined) {
      out.push(edge);
      continue;
    }
    if (!Array.isArray(extra)) return null;
    const base = edge.evidence === undefined ? [] : edge.evidence;
    const merged = normalizeEvidenceList(base.concat(extra), FAILURE_CORR_LIMITS.maxEvidencePerEdge);
    if (!merged.ok) return null;
    if (merged.value.length === 0 &&
        (edge.kind === 'OBSERVED_CAUSE' || edge.kind === 'CORRELATED_WITH')) return null;
    const next = { ...edge };
    if (merged.value.length > 0) next.evidence = merged.value;
    else delete next.evidence;
    out.push(Object.freeze(next));
  }
  return Object.freeze(out);
}

/** Export choke: canonical stable JSON of a compiled graph (body without the
 * non-serializable inbound/outbound adjacency maps). Secret-shaped content
 * fails closed -> null. Same graph -> same bytes. */
export function exportFailureCorrelation(graph) {
  if (graph === null || typeof graph !== 'object') return null;
  const body = {
    schemaVersion: graph.schemaVersion,
    contract: {
      id: graph.contract && graph.contract.id,
      version: graph.contract && graph.contract.version,
      owner: graph.contract && graph.contract.owner,
    },
    events: graph.events.map(e => ({ ...e })),
    edges: graph.edges.map(e => ({ ...e })),
    rootId: graph.rootId,
    evidenceMissing: [...graph.evidenceMissing],
  };
  let canonical;
  try {
    canonical = stableStringify(body);
  } catch {
    return null;
  }
  if (canonical === null || containsSecretShape(body)) return null;
  return canonical;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}
