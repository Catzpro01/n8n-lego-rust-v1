/** P9.11 execution diagnostics contract. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). A failed (or successful)
 * execution can be correlated to workflow/version/trigger/node/runtime;
 * resource state and checkpoint/replay/artifact references attach as bounded
 * optional evidence. Diagnostics are bounded; large execution state becomes a
 * reference (`state_ref`) — never duplicated. Missing evidence is represented
 * explicitly (`evidenceMissing`) so summaries stay usable. Secret-safe:
 * fields are classified through the P9.7 boundary (FORBIDDEN/SECRET values
 * never enter a diagnostic). `summarizeFailure` produces a standardized
 * failure summary with a stable `FFP:v1:` fingerprint over bounded non-secret
 * identity fields only. No I/O, no clock, no workflow import.
 */
import { classifyTelemetryField, containsSecretShape, REDACTION_MARKERS } from './telemetry-redaction.mjs';

export const EXEC_DIAG_CONTRACT = Object.freeze({
  id: 'observability.execution-diagnostics', version: '1.0.0', owner: 'agent-6',
});
export const EXEC_DIAG_OUTCOMES = Object.freeze(['success', 'failed']);
export const EXEC_DIAG_LIMITS = Object.freeze({
  identifierBytes: 128,
  errorCodeBytes: 64,
  errorClassBytes: 64,
  stageBytes: 64,
  maxResourceFields: 16,
  maxRefs: 16,
  maxMissing: 16,
  maxNodes: 32,
  maxStateBytes: 4096, // inline state only up to this; larger → state_ref
  maxWireBytes: 8192,
  maxSummaryBytes: 1024,
});
/** Identity correlation fields required/optional for a failed execution. */
export const EXEC_DIAG_IDENTITY_FIELDS = Object.freeze([
  'executionId', 'workflowId', 'workflowVersion', 'triggerId',
  'nodeId', 'nodeType', 'nodeVersion', 'runtimeId',
]);
export const EXEC_DIAG_EVIDENCE_KINDS = Object.freeze([
  'resource', 'checkpoint', 'replay', 'artifact', 'state',
]);
export const EXEC_DIAG_FAILURE_CLASSES = Object.freeze([
  'TIMEOUT', 'CAPACITY', 'CANCELLED', 'DEPENDENCY', 'VALIDATION',
  'INTERNAL', 'UNKNOWN',
]);
const SPEC_KEYS = Object.freeze([
  'outcome', 'identity', 'failure', 'resource', 'refs', 'state', 'nodes',
]);

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundedId(value, max = EXEC_DIAG_LIMITS.identifierBytes) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > max) return null;
  return value;
}
function safeString(value, max) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  if (containsSecretShape(value)) return null;
  return value;
}
/** Refs are bare identifiers — also reject loose auth-prefix shapes that the
 * full secret scanner's length floor might miss (Bearer/Basic + short token). */
function safeRef(value) {
  const id = boundedId(value);
  if (id === null) return null;
  if (containsSecretShape(id)) return null;
  if (/\b(?:bearer|basic)\s+\S/i.test(id)) return null;
  if (/\b(?:password|secret|token|api[-_]?key)\s*[:=]\s*\S/i.test(id)) return null;
  return id;
}

/** FNV-1a 32-bit over a canonical string → hex digest (pure, no clock). */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a bounded execution diagnostic. Returns null on invalid/secret-shaped
 * required input (fail-closed). Missing optional evidence is recorded, not
 * fatal.
 */
export function createExecutionDiagnostic(spec) {
  try {
    if (!isPlain(spec)) return null;
    const sk = Reflect.ownKeys(spec);
    if (sk.some(k => !SPEC_KEYS.includes(k))) return null;
    const outcome = spec.outcome;
    if (!EXEC_DIAG_OUTCOMES.includes(outcome)) return null;

    // ---- Identity correlation (required: executionId + workflowId) ----
    const identityIn = isPlain(spec.identity) ? spec.identity : null;
    if (spec.identity !== undefined && !identityIn) return null;
    const identity = {};
    const evidenceMissing = [];
    if (identityIn) {
      const ik = Reflect.ownKeys(identityIn);
      if (ik.some(k => !EXEC_DIAG_IDENTITY_FIELDS.includes(k))) return null;
    }
    for (const field of EXEC_DIAG_IDENTITY_FIELDS) {
      const raw = identityIn ? identityIn[field] : undefined;
      if (raw === undefined || raw === null) {
        identity[field] = null;
        if (field === 'executionId' || field === 'workflowId') {
          // Required for correlation on every outcome — fail closed.
          return null;
        }
        evidenceMissing.push(field);
        continue;
      }
      const id = boundedId(raw);
      if (id === null) {
        // secret-shaped or oversize identifier → fail closed (never store)
        return null;
      }
      // provenance/classification pass (FORBIDDEN names never appear here —
      // identity fields are an allowlist), value must not be secret-shaped
      const cls = classifyTelemetryField(field, id);
      if (cls.action === 'reject' || cls.action === 'redact') return null;
      identity[field] = id;
    }

    // ---- Failure block (required when outcome=failed) ----
    let failure = null;
    if (outcome === 'failed') {
      if (!isPlain(spec.failure)) return null;
      const fk = Reflect.ownKeys(spec.failure);
      if (fk.some(k => !['code', 'class', 'stage', 'message'].includes(k))) return null;
      const code = safeString(spec.failure.code ?? '', EXEC_DIAG_LIMITS.errorCodeBytes);
      if (code === null) return null;
      const fclass = spec.failure.class === undefined ? 'UNKNOWN'
        : EXEC_DIAG_FAILURE_CLASSES.includes(spec.failure.class) ? spec.failure.class
          : null;
      if (fclass === null) return null;
      const stage = spec.failure.stage === undefined ? null
        : safeString(spec.failure.stage, EXEC_DIAG_LIMITS.stageBytes);
      if (spec.failure.stage !== undefined && stage === null) return null;
      // Free-text message optional; sanitize through redaction boundary.
      let message = null;
      if (spec.failure.message !== undefined) {
        if (typeof spec.failure.message !== 'string' ||
            spec.failure.message.length > EXEC_DIAG_LIMITS.maxSummaryBytes) {
          return null;
        }
        if (containsSecretShape(spec.failure.message)) {
          // strip by replacing with marker — secret never enters diagnostic
          message = REDACTION_MARKERS.secretValue;
        } else {
          message = spec.failure.message;
        }
      }
      failure = Object.freeze({ code, class: fclass, stage, message });
    } else if (spec.failure !== undefined) {
      // success with a failure block is contradictory
      return null;
    }

    // ---- Resource snapshot (bounded, optional) ----
    let resource = null;
    if (spec.resource !== undefined) {
      if (!isPlain(spec.resource)) return null;
      const rk = Reflect.ownKeys(spec.resource);
      if (rk.length > EXEC_DIAG_LIMITS.maxResourceFields) return null;
      const out = {};
      let n = 0;
      for (const key of rk) {
        if (typeof key !== 'string' || key.length > 64) return null;
        if (n >= EXEC_DIAG_LIMITS.maxResourceFields) return null;
        const cls = classifyTelemetryField(key, spec.resource[key]);
        if (cls.action === 'reject') return null;
        if (cls.action === 'redact' || cls.action === 'reference') {
          // secret/sensitive resource fields are dropped, not stored
          continue;
        }
        const v = spec.resource[key];
        if (v === null || typeof v === 'number' || typeof v === 'boolean') {
          out[key] = v;
        } else if (typeof v === 'string') {
          if (containsSecretShape(v)) continue;
          if (v.length > EXEC_DIAG_LIMITS.identifierBytes) continue;
          out[key] = v;
        } else {
          return null;
        }
        n++;
      }
      resource = Object.freeze(out);
      if (Object.keys(out).length === 0) evidenceMissing.push('resource');
    } else {
      evidenceMissing.push('resource');
    }

    // ---- Checkpoint / replay / artifact references (bounded) ----
    let refs = null;
    if (spec.refs !== undefined) {
      if (!isPlain(spec.refs)) return null;
      const allowed = ['checkpoint', 'replay', 'artifacts'];
      const bk = Reflect.ownKeys(spec.refs);
      if (bk.some(k => !allowed.includes(k))) return null;
      const out = {};
      if (spec.refs.checkpoint !== undefined) {
        const id = safeRef(spec.refs.checkpoint);
        if (id === null) return null;
        out.checkpoint = id;
      }
      if (spec.refs.replay !== undefined) {
        const id = safeRef(spec.refs.replay);
        if (id === null) return null;
        out.replay = id;
      }
      if (spec.refs.artifacts !== undefined) {
        if (!Array.isArray(spec.refs.artifacts)) return null;
        if (spec.refs.artifacts.length > EXEC_DIAG_LIMITS.maxRefs) return null;
        const arts = [];
        for (const a of spec.refs.artifacts) {
          const id = safeRef(a);
          if (id === null) return null;
          arts.push(id);
        }
        out.artifacts = Object.freeze(arts);
      }
      if (Object.keys(out).length === 0) {
        evidenceMissing.push('refs');
      } else {
        refs = Object.freeze(out);
      }
    } else {
      evidenceMissing.push('refs');
    }

    // ---- Large execution state → reference, never duplicate ----
    let state = null;
    if (spec.state !== undefined) {
      if (spec.state === null) {
        evidenceMissing.push('state');
      } else if (typeof spec.state === 'string' || isPlain(spec.state) || Array.isArray(spec.state)) {
        // Measure approximate wire size without JSON when possible.
        let bytes;
        try {
          bytes = typeof spec.state === 'string'
            ? spec.state.length
            : JSON.stringify(spec.state)?.length ?? Infinity;
        } catch { bytes = Infinity; }
        if (!Number.isFinite(bytes) || bytes > EXEC_DIAG_LIMITS.maxStateBytes) {
          // Reference only — bounded descriptor, payload NOT copied.
          const refId = typeof spec.state === 'object' && spec.state !== null && typeof spec.state.ref === 'string'
            ? boundedId(spec.state.ref)
            : `state:${fnv1a(typeof spec.state === 'string' ? spec.state.slice(0, 256) : String(bytes))}:${bytes}`;
          if (refId === null) return null;
          state = Object.freeze({ state_ref: true, ref: refId, bytes });
        } else if (typeof spec.state === 'string') {
          if (containsSecretShape(spec.state)) return null;
          state = Object.freeze({ state_inline: true, bytes, value: spec.state });
        } else {
          if (containsSecretShape(spec.state)) return null;
          state = Object.freeze({ state_inline: true, bytes, value: spec.state });
        }
      } else {
        return null;
      }
    } else {
      evidenceMissing.push('state');
    }

    // ---- Node list (bounded identities) ----
    let nodes = null;
    if (spec.nodes !== undefined) {
      if (!Array.isArray(spec.nodes)) return null;
      if (spec.nodes.length > EXEC_DIAG_LIMITS.maxNodes) return null;
      const list = [];
      for (const n of spec.nodes) {
        if (!isPlain(n)) return null;
        const nk = Reflect.ownKeys(n);
        if (nk.some(k => !['nodeId', 'nodeType', 'nodeVersion', 'outcome'].includes(k))) return null;
        const nodeId = n.nodeId === undefined ? null : boundedId(n.nodeId);
        if (n.nodeId !== undefined && nodeId === null) return null;
        const nodeType = n.nodeType === undefined ? null : boundedId(n.nodeType);
        if (n.nodeType !== undefined && nodeType === null) return null;
        const nodeVersion = n.nodeVersion === undefined ? null : boundedId(n.nodeVersion, 32);
        if (n.nodeVersion !== undefined && nodeVersion === null) return null;
        const nodeOutcome = n.outcome === undefined ? null
          : (n.outcome === 'success' || n.outcome === 'failed' || n.outcome === 'skipped') ? n.outcome
            : null;
        if (n.outcome !== undefined && nodeOutcome === null) return null;
        list.push(Object.freeze({ nodeId, nodeType, nodeVersion, outcome: nodeOutcome }));
      }
      nodes = Object.freeze(list);
    }

    if (evidenceMissing.length > EXEC_DIAG_LIMITS.maxMissing) {
      evidenceMissing.length = EXEC_DIAG_LIMITS.maxMissing;
    }

    const diagnostic = {
      contractVersion: EXEC_DIAG_CONTRACT.version,
      outcome,
      identity: Object.freeze(identity),
      failure,
      resource,
      refs,
      state,
      nodes,
      evidenceMissing: Object.freeze(evidenceMissing.slice()),
    };

    // Wire bound — freeze after ensuring serializable & under cap.
    let wire;
    try {
      wire = JSON.stringify(diagnostic);
    } catch {
      return null;
    }
    if (wire === undefined || wire.length > EXEC_DIAG_LIMITS.maxWireBytes) return null;
    if (containsSecretShape(diagnostic)) return null;

    return Object.freeze(diagnostic);
  } catch {
    return null;
  }
}

/**
 * Standardized failure summary + stable FFP:v1 fingerprint over bounded
 * non-secret identity/failure fields only (never hashes secrets).
 * Returns null for non-failed or invalid diagnostics.
 */
export function summarizeFailure(diagnostic) {
  try {
    if (!isPlain(diagnostic)) return null;
    if (diagnostic.outcome !== 'failed' || !isPlain(diagnostic.failure)) return null;
    if (diagnostic.contractVersion !== EXEC_DIAG_CONTRACT.version) return null;
    const id = diagnostic.identity ?? {};
    const f = diagnostic.failure;
    // Canonical string: fixed field order, only present non-null values.
    const parts = [
      'FFP:v1',
      id.component ?? 'execution',
      id.workflowId ?? '-',
      id.workflowVersion ?? '-',
      id.triggerId ?? '-',
      id.nodeId ?? '-',
      id.nodeType ?? '-',
      id.nodeVersion ?? '-',
      id.runtimeId ?? '-',
      f.code,
      f.class,
      f.stage ?? '-',
    ].join('|');
    if (containsSecretShape(parts)) return null;
    const fingerprint = `FFP:v1:${fnv1a(parts)}`;
    const summary = {
      contractVersion: EXEC_DIAG_CONTRACT.version,
      fingerprint,
      outcome: 'failed',
      code: f.code,
      class: f.class,
      stage: f.stage,
      executionId: id.executionId ?? null,
      workflowId: id.workflowId ?? null,
      workflowVersion: id.workflowVersion ?? null,
      triggerId: id.triggerId ?? null,
      nodeId: id.nodeId ?? null,
      runtimeId: id.runtimeId ?? null,
      evidenceMissing: diagnostic.evidenceMissing ?? Object.freeze([]),
      hasResource: diagnostic.resource !== null && diagnostic.resource !== undefined,
      hasRefs: diagnostic.refs !== null && diagnostic.refs !== undefined,
      stateRef: isPlain(diagnostic.state) && diagnostic.state.state_ref === true
        ? Object.freeze({ ref: diagnostic.state.ref, bytes: diagnostic.state.bytes })
        : null,
    };
    let wire;
    try { wire = JSON.stringify(summary); } catch { return null; }
    if (wire === undefined || wire.length > EXEC_DIAG_LIMITS.maxSummaryBytes) return null;
    if (containsSecretShape(summary)) return null;
    return Object.freeze(summary);
  } catch {
    return null;
  }
}

/** Serialize a diagnostic with the same wire bound (export choke). */
export function serializeExecutionDiagnostic(diagnostic) {
  try {
    if (!isPlain(diagnostic)) return null;
    const wire = JSON.stringify(diagnostic);
    if (wire === undefined || wire.length > EXEC_DIAG_LIMITS.maxWireBytes) return null;
    if (containsSecretShape(diagnostic)) return null;
    return wire;
  } catch {
    return null;
  }
}
