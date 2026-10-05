/** P9-S01 per-node execution cost/resource ledger, correlated with P9 telemetry.
 * Product owner agent-6; Manager delegate (Issue #224 item 20). A ledger is the
 * missing half of P9's observability: P9.11 correlates a FAILED execution to its
 * node, and P9.9 reports pressure, but neither answers "what did this node cost,
 * and is that number measured or derived?" — which is the question a capacity
 * decision (P8) or a per-tenant accounting surface has to answer before it may
 * act on it.
 *
 * The correlation identity is deliberately the SAME field set P9.11 declares
 * (`EXEC_DIAG_IDENTITY_FIELDS`): a cost row that cannot be joined to a diagnostic
 * is a second, parallel truth, and two truths about one execution is exactly the
 * drift this plane exists to prevent.
 *
 * PROVENANCE IS NOT OPTIONAL. Every measured quantity carries `VALUE_PROVENANCE`
 * from P9.9 — OBSERVED (measured here), ESTIMATED (derived), REPORTED (a provider
 * actually said so). A ledger entry may never be promoted to REPORTED because a
 * number looks plausible: a provider-reported cost is only REPORTED when the
 * provider reported it, so a fabricated cost cannot enter a capacity decision.
 *
 * BOUNDED, per the plane's rule: a fixed maximum of nodes, samples per node, and
 * wire bytes. An over-limit node is REFUSED rather than silently truncated —
 * silent truncation is how a ledger quietly starts under-reporting spend.
 *
 * SECRET-SAFE: every string that enters a row passes the P9.7 boundary
 * (`classifyTelemetryField` / `containsSecretShape`), so a credential-shaped
 * label cannot become a cost dimension.
 *
 * No I/O, no clock, no workflow import. Pure functions over plain data, so the
 * ledger can be derived from a telemetry stream without the stream owning it.
 */
import { classifyTelemetryField, containsSecretShape } from './telemetry-redaction.mjs';
import { EXEC_DIAG_IDENTITY_FIELDS, EXEC_DIAG_LIMITS } from './execution-diagnostics.mjs';

export const NODE_COST_CONTRACT = Object.freeze({
  id: 'observability.node-cost-ledger', version: '1.0.0', owner: 'agent-6',
});

/**
 * Cost/resource dimensions a row may carry. `durationMs` and `invocations` are
 * always available; the rest only when something actually measured them.
 */
export const COST_DIMENSIONS = Object.freeze([
  'durationMs', 'invocations', 'cpuMs', 'memoryPeakBytes', 'bytesIn', 'bytesOut',
  'storageBytes', 'retries', 'failures',
]);

/** Dimensions that may never be negative, and the ones that are counts. */
export const COST_NUMERIC_LIMITS = Object.freeze({
  durationMs: Number.MAX_SAFE_INTEGER,
  cpuMs: Number.MAX_SAFE_INTEGER,
  memoryPeakBytes: Number.MAX_SAFE_INTEGER,
  bytesIn: Number.MAX_SAFE_INTEGER,
  bytesOut: Number.MAX_SAFE_INTEGER,
  storageBytes: Number.MAX_SAFE_INTEGER,
  invocations: Number.MAX_SAFE_INTEGER,
  retries: Number.MAX_SAFE_INTEGER,
  failures: Number.MAX_SAFE_INTEGER,
});

/** How a quantity came to be known. Re-exported from P9.9 so the ladder is one. */
export const COST_VALUE_PROVENANCE = Object.freeze(['OBSERVED', 'ESTIMATED', 'REPORTED']);

/**
 * Aggregation scopes. PER_NODE is the ledger's unit; PER_EXECUTION and
 * PER_WORKFLOW are derived views over the same rows, never separately recorded,
 * so the three can never disagree.
 */
export const COST_SCOPES = Object.freeze(['per-node', 'per-execution', 'per-workflow']);

export const COST_LIMITS = Object.freeze({
  identifierBytes: EXEC_DIAG_LIMITS.identifierBytes,
  maxNodes: 256,
  maxSamplesPerNode: 64,
  maxDimensions: COST_DIMENSIONS.length,
  maxLedgerRows: 4096,
  maxWireBytes: 16384,
  maxLabelBytes: 128,
  maxUnitBytes: 32,
  /** A single node's accumulated samples may not exceed this many rows. */
  maxNodeTotalSamples: 4096,
});

/** The identity a row must carry to be correlatable with P9 telemetry. */
export const COST_IDENTITY_FIELDS = Object.freeze([...EXEC_DIAG_IDENTITY_FIELDS]);

/** Outcome vocabulary, shared with P9.11 so a cost row and a diagnostic agree. */
export const COST_OUTCOMES = Object.freeze(['success', 'failed']);

const IDENTITY_KEYS = Object.freeze([...COST_IDENTITY_FIELDS]);
const SPEC_KEYS = Object.freeze([
  'identity', 'outcome', 'dimensions', 'provenance', 'unit', 'label', 'at', 'refs',
]);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedId(value, max = COST_LIMITS.identifierBytes) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > max) return null;
  if (containsSecretShape(value)) return null;
  return value;
}

/** A non-negative finite integer within the dimension's own bound. */
function boundedCount(value, dimension) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < 0) return null;
  const max = COST_NUMERIC_LIMITS[dimension];
  if (max !== undefined && value > max) return null;
  return value;
}

/** A safe, bounded, secret-free free-text field (label/unit). */
function safeText(value, max) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  if (containsSecretShape(value)) return null;
  return value;
}

/** FNV-1a 32-bit over a canonical string → hex digest (pure, no clock). */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x0101_93) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Canonical string for a row's correlatable identity, used for the fingerprint.
 * Key order is FIXED here rather than taken from the input object, so two rows
 * with the same identity written in different key orders fingerprint the same.
 */
function identityKey(identity) {
  return IDENTITY_KEYS.map((key) => `${key}=${identity[key] ?? ''}`).join('|');
}

/**
 * Build one cost/resource row. Returns null on invalid or secret-shaped input
 * (fail-closed): a row that cannot be correlated is not a cheap row, it is a
 * lie about spend, so it is refused rather than stored.
 *
 * @param {object} spec
 * @param {object} spec.identity        the P9.11 correlation identity
 * @param {'success'|'failed'} [spec.outcome]
 * @param {object} spec.dimensions      dimension -> non-negative integer
 * @param {'OBSERVED'|'ESTIMATED'|'REPORTED'} spec.provenance
 * @param {string} [spec.unit]          e.g. 'ms', 'bytes', 'usd-micros'
 * @param {string} [spec.label]
 * @param {string} [spec.at]            ISO-8601 Z, supplied by the caller
 * @param {string[]} [spec.refs]        bare identifiers (run ids, sample ids)
 * @returns {Readonly<object>|null}
 */
export function createNodeCostRow(spec) {
  if (!isPlain(spec)) return null;
  const unknown = Object.keys(spec).filter((key) => !SPEC_KEYS.includes(key));
  if (unknown.length) return null;

  const identity = {};
  if (!isPlain(spec.identity)) return null;
  for (const key of IDENTITY_KEYS) {
    // executionId and nodeId are the join keys; without them a row is orphaned.
    const required = key === 'executionId' || key === 'nodeId';
    const value = boundedId(spec.identity[key]);
    if (value === null) {
      if (required) return null;
      continue;
    }
    identity[key] = value;
  }

  const outcome = spec.outcome === undefined ? 'success' : spec.outcome;
  if (!COST_OUTCOMES.includes(outcome)) return null;

  // Provenance is required. A row without it is an unmeasurable claim.
  if (!COST_VALUE_PROVENANCE.includes(spec.provenance)) return null;

  if (!isPlain(spec.dimensions)) return null;
  const dimensions = {};
  for (const [key, value] of Object.entries(spec.dimensions)) {
    if (!COST_DIMENSIONS.includes(key)) return null;
    // `invocations` is a count of calls, not a cost, and is always OBSERVED.
    const counted = boundedCount(value, key);
    if (counted === null) return null;
    dimensions[key] = counted;
  }
  if (!Object.keys(dimensions).length) return null;

  const row = { identity: Object.freeze(identity), outcome, provenance: spec.provenance };
  if (spec.unit !== undefined) {
    const unit = safeText(spec.unit, COST_LIMITS.maxUnitBytes);
    if (unit === null) return null;
    row.unit = unit;
  }
  if (spec.label !== undefined) {
    const label = safeText(spec.label, COST_LIMITS.maxLabelBytes);
    if (label === null) return null;
    row.label = label;
  }
  if (spec.at !== undefined) {
    if (typeof spec.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(spec.at)) return null;
    row.at = spec.at;
  }
  if (spec.refs !== undefined) {
    if (!Array.isArray(spec.refs)) return null;
    const refs = [];
    for (const ref of spec.refs) {
      const safe = boundedId(ref);
      if (safe === null) return null;
      refs.push(safe);
    }
    if (refs.length) row.refs = Object.freeze(refs);
  }
  row.dimensions = Object.freeze(dimensions);
  row.fingerprint = fingerprintRow(identity, outcome);
  return Object.freeze(row);
}

/**
 * Stable fingerprint over the correlatable identity and the outcome only.
 * Deliberately NOT over the measured values: the same node in the same execution
 * must fingerprint identically whether it cost 4 ms or 40, so a retry or a
 * re-measure joins to the row it belongs to instead of forking a new one.
 */
export function fingerprintRow(identity, outcome = 'success') {
  if (!isPlain(identity)) return null;
  const clean = {};
  for (const key of IDENTITY_KEYS) {
    const value = boundedId(identity[key]);
    if (value !== null) clean[key] = value;
  }
  if (!COST_OUTCOMES.includes(outcome)) return null;
  return `NC:v1:${fnv1a(`${identityKey(clean)}|${outcome}`)}`;
}

/**
 * Accumulate rows into a bounded per-node ledger.
 *
 * The ledger is the correlatable view: it keeps one entry per
 * (node, execution, outcome) and sums the dimensions of every row that lands on
 * the same fingerprint, so N samples of one node invocation become one entry
 * with N recorded — not N entries that a reader has to add up.
 *
 * Over-limit is REFUSED, not truncated: `addNodeCostRow` returns false and the
 * caller decides. A ledger that silently drops rows under-reports spend, which
 * is the failure mode this plane is supposed to make impossible.
 */
export function createNodeCostLedger({ maxNodes = COST_LIMITS.maxNodes, maxSamplesPerNode = COST_LIMITS.maxSamplesPerNode } = {}) {
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > COST_LIMITS.maxNodes) return null;
  if (!Number.isInteger(maxSamplesPerNode) || maxSamplesPerNode < 1 || maxSamplesPerNode > COST_LIMITS.maxSamplesPerNode) return null;

  /** @type {Map<string, {nodeId:string,nodeType:string,samples:number,totals:object,provenance:Set<string>,firstAt:string|null,lastAt:string|null}>} */
  const nodes = new Map();
  let rows = 0;

  const entryKey = (row) => `${row.fingerprint}`;

  return {
    get size() { return nodes.size; },
    get rows() { return rows; },
    get bounded() { return rows >= COST_LIMITS.maxLedgerRows; },

    /**
     * @returns {boolean} true when the row was recorded, false when the ledger
     *          refused it (over a bound). The caller MUST surface a refusal.
     */
    add(row) {
      if (!row || typeof row.fingerprint !== 'string') return false;
      // A row is only a row if it carries the shape a reader depends on. A
      // half-populated row would silently under-count a dimension.
      if (!isPlain(row.identity) || typeof row.identity.nodeId !== 'string') return false;
      if (!COST_VALUE_PROVENANCE.includes(row.provenance)) return false;
      if (!isPlain(row.dimensions) || !Object.keys(row.dimensions).length) return false;
      if (rows >= COST_LIMITS.maxLedgerRows) return false;
      const key = entryKey(row);
      let entry = nodes.get(key);
      if (!entry) {
        if (nodes.size >= maxNodes) return false;
        entry = {
          nodeId: row.identity.nodeId,
          nodeType: row.identity.nodeType ?? null,
          samples: 0,
          totals: {},
          provenance: new Set(),
          firstAt: row.at ?? null,
          lastAt: row.at ?? null,
        };
        nodes.set(key, entry);
      }
      if (entry.samples >= maxSamplesPerNode) return false;
      entry.samples += 1;
      entry.provenance.add(row.provenance);
      for (const [dimension, value] of Object.entries(row.dimensions)) {
        entry.totals[dimension] = (entry.totals[dimension] ?? 0) + value;
      }
      if (row.at) {
        if (!entry.firstAt || row.at < entry.firstAt) entry.firstAt = row.at;
        if (!entry.lastAt || row.at > entry.lastAt) entry.lastAt = row.at;
      }
      rows += 1;
      return true;
    },

    /** The correlatable projection: one record per accumulated node invocation. */
    entries() {
      return [...nodes.entries()].map(([fingerprint, entry]) => Object.freeze({
        fingerprint,
        nodeId: entry.nodeId,
        nodeType: entry.nodeType,
        samples: entry.samples,
        totals: Object.freeze({ ...entry.totals }),
        // A node whose totals mix OBSERVED and ESTIMATED says so: a consumer
        // must not read a mixed total as if the whole of it were measured.
        provenance: Object.freeze([...entry.provenance].sort()),
        mixedProvenance: entry.provenance.size > 1,
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
      }));
    },

    /** Per-node rollup across every execution in the ledger. */
    byNode() {
      const rollup = new Map();
      for (const entry of this.entries()) {
        const current = rollup.get(entry.nodeId) ?? { nodeId: entry.nodeId, nodeType: entry.nodeType, invocations: 0, totals: {}, provenance: new Set() };
        current.invocations += entry.samples;
        current.provenance = new Set([...current.provenance, ...entry.provenance]);
        for (const [dimension, value] of Object.entries(entry.totals)) {
          current.totals[dimension] = (current.totals[dimension] ?? 0) + value;
        }
        rollup.set(entry.nodeId, current);
      }
      return [...rollup.values()].map((entry) => Object.freeze({
        nodeId: entry.nodeId,
        nodeType: entry.nodeType,
        invocations: entry.invocations,
        totals: Object.freeze({ ...entry.totals }),
        provenance: Object.freeze([...entry.provenance].sort()),
        mixedProvenance: entry.provenance.size > 1,
      }));
    },

    /**
     * Correlate a ledger against P9 telemetry by fingerprint. A row that matches
     * nothing is reported as UNMATCHED rather than dropped: an orphan cost row
     * is a signal that the telemetry stream and the ledger disagree, and hiding
     * it would hide the drift.
     */
    correlate(rows) {
      if (!Array.isArray(rows)) return null;
      const known = new Set(nodes.keys());
      const matched = [];
      const unmatched = [];
      for (const row of rows) {
        if (!row || typeof row.fingerprint !== 'string') continue;
        (known.has(row.fingerprint) ? matched : unmatched).push(row.fingerprint);
      }
      return Object.freeze({
        matched: Object.freeze(matched),
        unmatched: Object.freeze(unmatched),
        // Coverage is matched / (matched + unmatched) over the supplied rows.
        coverage: matched.length + unmatched.length === 0
          ? null
          : matched.length / (matched.length + unmatched.length),
      });
    },

    /** Bounded serialisation: refuses rather than emitting an oversized document. */
    serialize() {
      const payload = { contract: NODE_COST_CONTRACT.id, version: NODE_COST_CONTRACT.version, nodes: this.byNode() };
      const text = JSON.stringify(payload);
      if (text.length > COST_LIMITS.maxWireBytes) return null;
      return text;
    },
  };
}

/**
 * Redaction gate for a candidate dimension map, exposed so a caller can check a
 * payload BEFORE it becomes a row. Fail-closed: any FORBIDDEN/SECRET-shaped key
 * or value rejects the whole map.
 */
export function costDimensionsAllowed(dimensions) {
  if (!isPlain(dimensions)) return false;
  for (const [key, value] of Object.entries(dimensions)) {
    if (!COST_DIMENSIONS.includes(key)) return false;
    if (classifyTelemetryField(key, value).action === 'reject') return false;
    if (containsSecretShape(key) || (typeof value === 'string' && containsSecretShape(value))) return false;
  }
  return true;
}
