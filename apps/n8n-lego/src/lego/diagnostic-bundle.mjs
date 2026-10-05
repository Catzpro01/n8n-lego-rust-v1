/** P9.12 diagnostic bundle compiler. Product owner agent-6; implementation
 * delegate Agent 4 (Issue #101). Produces a bounded, deterministic incident
 * bundle from correlation context + candidate logs/events/spans: selects
 * relevant signals (never dumps everything), enforces size and time budgets,
 * represents missing evidence explicitly, redacts secrets through the P9.7
 * boundary, and stamps an integrity digest so export/import can be verified
 * and tampering detected. Same inputs + same policy → same bundle bytes.
 * No I/O, no clock, no workflow import.
 */
import { classifyTelemetryField, containsSecretShape, REDACTION_MARKERS } from './telemetry-redaction.mjs';

export const DIAG_BUNDLE_CONTRACT = Object.freeze({
  id: 'observability.diagnostic-bundle', version: '1.0.0', owner: 'agent-6',
});
export const DIAG_BUNDLE_SCHEMA_VERSION = '1.0.0';
export const DIAG_BUNDLE_LIMITS = Object.freeze({
  identifierBytes: 128,
  maxCorrelationFields: 16,
  maxLogs: 64,
  maxEvents: 64,
  maxSpans: 32,
  maxRefs: 16,
  maxConfigFingerprints: 8,
  maxMissing: 32,
  maxCandidatesPerKind: 512,
  /** Absolute wire ceiling for a compiled bundle (policy may lower, never raise). */
  maxWireBytes: 65536,
  /** Default policy budgets when caller omits them. */
  defaultMaxBundleBytes: 32768,
  defaultMaxTimeWindowMs: 900000, // 15 minutes
  maxTimeWindowMs: 86400000, // hard ceiling: 24h
  minTimeWindowMs: 1000,
  maxPolicyBytesFloor: 512, // policy.maxBundleBytes must leave room for core
  maxLogBytes: 1024,
  maxEventBytes: 1024,
  maxSpanBytes: 512,
});
export const DIAG_BUNDLE_SECTIONS = Object.freeze([
  'correlation', 'diagnostic', 'logs', 'events', 'spans',
  'resource', 'refs', 'configFingerprints',
]);
export const DIAG_BUNDLE_SIGNAL_KINDS = Object.freeze(['log', 'event', 'span']);
export const DIAG_BUNDLE_BUDGET_REASONS = Object.freeze([
  'budget', 'relevance', 'window', 'count', 'invalid',
]);
export const DIAG_BUNDLE_CORRELATION_FIELDS = Object.freeze([
  'executionId', 'workflowId', 'workflowVersion', 'triggerId',
  'nodeId', 'nodeType', 'nodeVersion', 'runtimeId',
  'requestId', 'correlationId', 'traceId', 'checkpointId', 'registryEpoch',
]);
const SPEC_KEYS = Object.freeze([
  'correlation', 'diagnostic', 'candidates', 'resource', 'refs',
  'configFingerprints', 'anchorTimestamp', 'policy',
]);
const SEVERITY_RANK = Object.freeze({
  FATAL: 0, ERROR: 1, WARN: 2, INFO: 3, DEBUG: 4, TRACE: 5,
});

function isPlain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function boundedId(value, max = DIAG_BUNDLE_LIMITS.identifierBytes) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return null;
  return value;
}
function safeRef(value) {
  const id = boundedId(value);
  if (id === null) return null;
  if (containsSecretShape(id)) return null;
  if (/\b(?:bearer|basic)\s+\S/i.test(id)) return null;
  if (/\b(?:password|secret|token|api[-_]?key)\s*[:=]\s*\S/i.test(id)) return null;
  return id;
}
/** FNV-1a 32-bit → 8 hex (pure, no clock) — same family as P9.11 fingerprints. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
/** Stable digest over a canonical JSON string of the bundle body (no integrity field). */
function contentDigest(canonical) {
  // Double-mix so short collisions are harder for integrity checks.
  return `BDL:v1:${fnv1a(canonical)}${fnv1a(canonical.split('').reverse().join(''))}`;
}
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}
/** Body of a bundle excluding the integrity envelope (digest field). */
function bundleBody(bundle) {
  const { integrity, ...rest } = bundle;
  return rest;
}

function parsePolicy(policy, hardMax) {
  const out = {
    maxBundleBytes: Math.min(DIAG_BUNDLE_LIMITS.defaultMaxBundleBytes, hardMax),
    maxTimeWindowMs: DIAG_BUNDLE_LIMITS.defaultMaxTimeWindowMs,
    maxLogs: DIAG_BUNDLE_LIMITS.maxLogs,
    maxEvents: DIAG_BUNDLE_LIMITS.maxEvents,
    maxSpans: DIAG_BUNDLE_LIMITS.maxSpans,
    minSeverity: 'INFO',
  };
  if (policy === undefined) return out;
  if (!isPlain(policy)) return null;
  const allowed = ['maxBundleBytes', 'maxTimeWindowMs', 'maxLogs', 'maxEvents', 'maxSpans', 'minSeverity'];
  if (Reflect.ownKeys(policy).some(k => !allowed.includes(k))) return null;
  if (policy.maxBundleBytes !== undefined) {
    if (!Number.isSafeInteger(policy.maxBundleBytes) ||
        policy.maxBundleBytes < DIAG_BUNDLE_LIMITS.maxPolicyBytesFloor ||
        policy.maxBundleBytes > hardMax) return null;
    out.maxBundleBytes = policy.maxBundleBytes;
  }
  if (policy.maxTimeWindowMs !== undefined) {
    if (!Number.isSafeInteger(policy.maxTimeWindowMs) ||
        policy.maxTimeWindowMs < DIAG_BUNDLE_LIMITS.minTimeWindowMs ||
        policy.maxTimeWindowMs > DIAG_BUNDLE_LIMITS.maxTimeWindowMs) return null;
    out.maxTimeWindowMs = policy.maxTimeWindowMs;
  }
  if (policy.maxLogs !== undefined) {
    if (!Number.isSafeInteger(policy.maxLogs) || policy.maxLogs < 0 ||
        policy.maxLogs > DIAG_BUNDLE_LIMITS.maxLogs) return null;
    out.maxLogs = policy.maxLogs;
  }
  if (policy.maxEvents !== undefined) {
    if (!Number.isSafeInteger(policy.maxEvents) || policy.maxEvents < 0 ||
        policy.maxEvents > DIAG_BUNDLE_LIMITS.maxEvents) return null;
    out.maxEvents = policy.maxEvents;
  }
  if (policy.maxSpans !== undefined) {
    if (!Number.isSafeInteger(policy.maxSpans) || policy.maxSpans < 0 ||
        policy.maxSpans > DIAG_BUNDLE_LIMITS.maxSpans) return null;
    out.maxSpans = policy.maxSpans;
  }
  if (policy.minSeverity !== undefined) {
    if (!(policy.minSeverity in SEVERITY_RANK)) return null;
    out.minSeverity = policy.minSeverity;
  }
  return out;
}

/**
 * Normalize one candidate signal. Returns { kind, item, score, timestamp } or null
 * (invalid/secret → counted as invalid drop by caller).
 */
function normalizeCandidate(kind, raw, correlation, window, anchor) {
  if (!isPlain(raw)) return null;
  const ts = raw.timestamp;
  if (!Number.isSafeInteger(ts) || ts < 0) return null;
  // Time budget: outside [anchor-window, anchor+window] → reject (caller drops).
  if (anchor !== null) {
    if (ts < anchor - window || ts > anchor + window) return { outsideWindow: true };
  }
  if (containsSecretShape({ ...raw, message: undefined })) return null;

  if (kind === 'log') {
    const keys = Reflect.ownKeys(raw);
    const allowed = ['timestamp', 'severity', 'operation', 'outcome', 'errorCode', 'message', 'executionId', 'workflowId'];
    if (keys.some(k => !allowed.includes(k))) return null;
    if (!(raw.severity in SEVERITY_RANK)) return null;
    if (typeof raw.operation !== 'string' || raw.operation.length === 0 || raw.operation.length > 64) return null;
    if (typeof raw.outcome !== 'string' || raw.outcome.length === 0 || raw.outcome.length > 32) return null;
    let errorCode = null;
    if (raw.errorCode !== undefined && raw.errorCode !== null) {
      errorCode = boundedId(raw.errorCode, 64);
      if (errorCode === null) return null;
    }
    let message = null;
    if (raw.message !== undefined && raw.message !== null) {
      if (typeof raw.message !== 'string' || raw.message.length > DIAG_BUNDLE_LIMITS.maxLogBytes) return null;
      if (containsSecretShape(raw.message)) message = REDACTION_MARKERS.secretValue;
      else message = raw.message;
    }
    const execId = raw.executionId === undefined ? null : boundedId(raw.executionId);
    if (raw.executionId !== undefined && execId === null) return null;
    const wfId = raw.workflowId === undefined ? null : boundedId(raw.workflowId);
    if (raw.workflowId !== undefined && wfId === null) return null;
    const item = { timestamp: ts, severity: raw.severity, operation: raw.operation, outcome: raw.outcome, errorCode, message };
    if (execId) item.executionId = execId;
    if (wfId) item.workflowId = wfId;
    // Relevance: exact correlation match beats severity; FATAL/ERROR elevated.
    let score = 100;
    if (execId && execId === correlation.executionId) score += 400;
    else if (execId) score -= 100;
    if (wfId && wfId === correlation.workflowId) score += 200;
    else if (wfId) score -= 50;
    score += (5 - SEVERITY_RANK[raw.severity]) * 20;
    if (errorCode) score += 30;
    return { kind, item, score, timestamp: ts };
  }

  if (kind === 'event') {
    const keys = Reflect.ownKeys(raw);
    const allowed = ['timestamp', 'eventName', 'severity', 'sequence', 'executionId', 'workflowId'];
    if (keys.some(k => !allowed.includes(k))) return null;
    if (typeof raw.eventName !== 'string' || raw.eventName.length === 0 || raw.eventName.length > 64) return null;
    if (!(raw.severity in SEVERITY_RANK)) return null;
    if (raw.sequence !== undefined && (!Number.isSafeInteger(raw.sequence) || raw.sequence < 0)) return null;
    const execId = raw.executionId === undefined ? null : boundedId(raw.executionId);
    if (raw.executionId !== undefined && execId === null) return null;
    const wfId = raw.workflowId === undefined ? null : boundedId(raw.workflowId);
    if (raw.workflowId !== undefined && wfId === null) return null;
    const item = { timestamp: ts, eventName: raw.eventName, severity: raw.severity };
    if (raw.sequence !== undefined) item.sequence = raw.sequence;
    if (execId) item.executionId = execId;
    if (wfId) item.workflowId = wfId;
    let score = 100;
    if (execId && execId === correlation.executionId) score += 400;
    if (wfId && wfId === correlation.workflowId) score += 200;
    score += (5 - SEVERITY_RANK[raw.severity]) * 20;
    if (raw.eventName.includes('fail') || raw.eventName.includes('error')) score += 50;
    return { kind, item, score, timestamp: ts };
  }

  // span
  const keys = Reflect.ownKeys(raw);
  const allowed = ['timestamp', 'name', 'spanId', 'traceId', 'durationMs', 'outcome', 'executionId'];
  if (keys.some(k => !allowed.includes(k))) return null;
  if (typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.length > 64) return null;
  const spanId = raw.spanId === undefined ? null : boundedId(raw.spanId, 32);
  if (raw.spanId !== undefined && spanId === null) return null;
  const traceId = raw.traceId === undefined ? null : boundedId(raw.traceId, 32);
  if (raw.traceId !== undefined && traceId === null) return null;
  if (raw.durationMs !== undefined && (typeof raw.durationMs !== 'number' || raw.durationMs < 0)) return null;
  if (raw.outcome !== undefined && !['success', 'failed', 'running'].includes(raw.outcome)) return null;
  const execId = raw.executionId === undefined ? null : boundedId(raw.executionId);
  if (raw.executionId !== undefined && execId === null) return null;
  const item = { timestamp: ts, name: raw.name };
  if (spanId) item.spanId = spanId;
  if (traceId) item.traceId = traceId;
  if (raw.durationMs !== undefined) item.durationMs = raw.durationMs;
  if (raw.outcome !== undefined) item.outcome = raw.outcome;
  if (execId) item.executionId = execId;
  let score = 80;
  if (execId && execId === correlation.executionId) score += 400;
  if (correlation.traceId && traceId === correlation.traceId) score += 300;
  if (raw.outcome === 'failed') score += 60;
  return { kind, item, score, timestamp: ts };
}

/**
 * Compile a bounded diagnostic bundle deterministically.
 * Returns a frozen bundle (with integrity) or null on invalid/secret core input.
 * Budget overruns never throw: dropped candidates are counted; if even the core
 * cannot fit `budget.exceeded` is true and the bundle still reports honestly.
 */
export function compileDiagnosticBundle(spec) {
  try {
    if (!isPlain(spec)) return null;
    if (Reflect.ownKeys(spec).some(k => !SPEC_KEYS.includes(k))) return null;

    // ---- Correlation context (required: executionId + workflowId) ----
    const corrIn = spec.correlation;
    if (!isPlain(corrIn)) return null;
    const ck = Reflect.ownKeys(corrIn);
    if (ck.some(k => !DIAG_BUNDLE_CORRELATION_FIELDS.includes(k))) return null;
    const correlation = {};
    let evidenceMissing = [];
    for (const field of DIAG_BUNDLE_CORRELATION_FIELDS) {
      const raw = corrIn[field];
      if (raw === undefined || raw === null) {
        if (field === 'executionId' || field === 'workflowId') return null;
        evidenceMissing.push(field);
        continue;
      }
      if (field === 'registryEpoch') {
        if (!Number.isSafeInteger(raw) || raw < 0) return null;
        correlation[field] = raw;
        continue;
      }
      const id = boundedId(raw);
      if (id === null) return null;
      const cls = classifyTelemetryField(field, id);
      if (cls.action === 'reject' || cls.action === 'redact') return null;
      correlation[field] = id;
    }

    // ---- Policy (optional; fail-closed on unknown/invalid keys) ----
    const policy = parsePolicy(spec.policy, DIAG_BUNDLE_LIMITS.maxWireBytes);
    if (policy === null) return null;

    // ---- Anchor + time window (no clock: anchor is caller-supplied) ----
    let anchor = null;
    if (spec.anchorTimestamp !== undefined && spec.anchorTimestamp !== null) {
      if (!Number.isSafeInteger(spec.anchorTimestamp) || spec.anchorTimestamp < 0) return null;
      anchor = spec.anchorTimestamp;
    }

    // ---- Optional P9.11 diagnostic (already secret-safe when present) ----
    let diagnostic = null;
    if (spec.diagnostic !== undefined && spec.diagnostic !== null) {
      const d = spec.diagnostic;
      if (!isPlain(d) || d.contractVersion === undefined || d.outcome === undefined) return null;
      // Shallow allow: embed only known top-level diagnostic shape fields.
      const allowed = ['contractVersion', 'outcome', 'identity', 'failure', 'resource', 'refs', 'state', 'nodes', 'evidenceMissing'];
      if (Reflect.ownKeys(d).some(k => !allowed.includes(k))) return null;
      if (containsSecretShape(d)) return null;
      diagnostic = d;
    } else {
      evidenceMissing.push('diagnostic');
    }

    // ---- Resource (optional, same bounds as P9.11) ----
    let resource = null;
    if (spec.resource !== undefined && spec.resource !== null) {
      if (!isPlain(spec.resource)) return null;
      const rk = Reflect.ownKeys(spec.resource);
      if (rk.length > 16) return null;
      const out = {};
      for (const key of rk) {
        if (typeof key !== 'string' || key.length > 64) return null;
        const cls = classifyTelemetryField(key, spec.resource[key]);
        if (cls.action === 'reject') return null;
        if (cls.action === 'redact' || cls.action === 'reference') continue;
        const v = spec.resource[key];
        if (v === null || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
        else if (typeof v === 'string') {
          if (containsSecretShape(v) || v.length > DIAG_BUNDLE_LIMITS.identifierBytes) continue;
          out[key] = v;
        } else return null;
      }
      if (Object.keys(out).length === 0) evidenceMissing.push('resource');
      else resource = out;
    } else evidenceMissing.push('resource');

    // ---- Refs (checkpoint/replay/artifacts) ----
    let refs = null;
    if (spec.refs !== undefined && spec.refs !== null) {
      if (!isPlain(spec.refs)) return null;
      const allowed = ['checkpoint', 'replay', 'artifacts'];
      if (Reflect.ownKeys(spec.refs).some(k => !allowed.includes(k))) return null;
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
        if (!Array.isArray(spec.refs.artifacts) || spec.refs.artifacts.length > DIAG_BUNDLE_LIMITS.maxRefs) return null;
        const arts = [];
        for (const a of spec.refs.artifacts) {
          const id = safeRef(a);
          if (id === null) return null;
          arts.push(id);
        }
        out.artifacts = arts;
      }
      if (Object.keys(out).length === 0) evidenceMissing.push('refs');
      else refs = out;
    } else evidenceMissing.push('refs');

    // ---- Config fingerprints (short non-secret digests) ----
    let configFingerprints = null;
    if (spec.configFingerprints !== undefined && spec.configFingerprints !== null) {
      if (!Array.isArray(spec.configFingerprints)) return null;
      if (spec.configFingerprints.length > DIAG_BUNDLE_LIMITS.maxConfigFingerprints) return null;
      const list = [];
      for (const fp of spec.configFingerprints) {
        if (!isPlain(fp)) return null;
        const fk = Reflect.ownKeys(fp);
        if (fk.some(k => !['key', 'value'].includes(k))) return null;
        const key = boundedId(fp.key, 64);
        if (key === null) return null;
        const value = boundedId(fp.value, 64);
        if (value === null) return null;
        const cls = classifyTelemetryField(key, value);
        if (cls.action !== 'allow') return null;
        list.push({ key, value });
      }
      if (list.length === 0) evidenceMissing.push('configFingerprints');
      else configFingerprints = list;
    } else evidenceMissing.push('configFingerprints');

    // ---- Candidates: select relevant signals under budgets ----
    const candidatesIn = spec.candidates === undefined ? {} : spec.candidates;
    if (!isPlain(candidatesIn)) return null;
    const sections = ['logs', 'events', 'spans'];
    const toKind = { logs: 'log', events: 'event', spans: 'span' };
    if (Reflect.ownKeys(candidatesIn).some(k => !sections.includes(k))) return null;

    const dropped = { logs: 0, events: 0, spans: 0 };
    const droppedBy = { logs: new Map(), events: new Map(), spans: new Map() };
    const noteDrop = (section, reason, n = 1) => {
      dropped[section] += n;
      droppedBy[section].set(reason, (droppedBy[section].get(reason) ?? 0) + n);
    };

    const normalized = { log: [], event: [], span: [] };
    for (const section of sections) {
      const kind = toKind[section];
      const arr = candidatesIn[section];
      if (arr === undefined) {
        evidenceMissing.push(section);
        continue;
      }
      if (!Array.isArray(arr)) return null;
      if (arr.length > DIAG_BUNDLE_LIMITS.maxCandidatesPerKind) return null;
      for (const raw of arr) {
        const n = normalizeCandidate(kind, raw, correlation, policy.maxTimeWindowMs, anchor);
        if (n === null) { noteDrop(section, 'invalid'); continue; }
        if (n.outsideWindow === true) { noteDrop(section, 'window'); continue; }
        // minSeverity filter (applies to log/event; spans without severity always eligible)
        if (kind !== 'span' && SEVERITY_RANK[n.item.severity] > SEVERITY_RANK[policy.minSeverity]) {
          noteDrop(section, 'relevance');
          continue;
        }
        normalized[kind].push(n);
      }
      if (arr.length === 0) evidenceMissing.push(section);
    }

    // Deterministic order: score desc, timestamp asc, then original index asc.
    for (const kind of DIAG_BUNDLE_SIGNAL_KINDS) {
      const list = normalized[kind];
      list.forEach((n, i) => { n.index = i; });
      list.sort((a, b) =>
        (b.score - a.score) || (a.timestamp - b.timestamp) || (a.index - b.index));
    }

    // Greedy fill under per-kind count + global byte budget.
    const picked = { logs: [], events: [], spans: [] };
    const limits = {
      logs: { max: policy.maxLogs, cap: DIAG_BUNDLE_LIMITS.maxLogBytes, key: 'logs' },
      events: { max: policy.maxEvents, cap: DIAG_BUNDLE_LIMITS.maxEventBytes, key: 'events' },
      spans: { max: policy.maxSpans, cap: DIAG_BUNDLE_LIMITS.maxSpanBytes, key: 'spans' },
    };
    // Core skeleton bytes (correlation + policy + empty sections) — budgeted too.
    const skeleton = {
      schemaVersion: DIAG_BUNDLE_SCHEMA_VERSION,
      contractVersion: DIAG_BUNDLE_CONTRACT.version,
      correlation,
      policy: {
        maxBundleBytes: policy.maxBundleBytes,
        maxTimeWindowMs: policy.maxTimeWindowMs,
        maxLogs: policy.maxLogs,
        maxEvents: policy.maxEvents,
        maxSpans: policy.maxSpans,
        minSeverity: policy.minSeverity,
      },
      diagnostic, resource, refs, configFingerprints,
      logs: [], events: [], spans: [],
      evidenceMissing: [],
      dropped: { logs: 0, events: 0, spans: 0 },
      budget: { maxBytes: policy.maxBundleBytes, usedBytes: 0, exceeded: false },
    };
    let running = stableStringify(skeleton).length;

    const kindMap = { logs: 'log', events: 'event', spans: 'span' };
    for (const section of ['logs', 'events', 'spans']) {
      const lim = limits[section];
      const k = kindMap[section];
      for (const cand of normalized[k]) {
        if (picked[section].length >= lim.max) { noteDrop(section, 'count'); continue; }
        const itemJson = stableStringify(cand.item).length + 1;
        if (running + itemJson > policy.maxBundleBytes) {
          noteDrop(section, 'budget');
          continue;
        }
        running += itemJson;
        picked[section].push(cand.item);
      }
      // Remaining unpicked already counted per-candidate above; also count any never iterated?
      // (loop visits all; count/budget drops noted)
    }

    // Summarize drop reasons into a compact object for the wire.
    const dropSummary = { logs: 0, events: 0, spans: 0, reasons: {} };
    for (const kind of ['logs', 'events', 'spans']) {
      dropSummary[kind] = dropped[kind];
      for (const [reason, n] of droppedBy[kind]) {
        dropSummary.reasons[`${kind}.${reason}`] = n;
      }
    }
    if (evidenceMissing.length > DIAG_BUNDLE_LIMITS.maxMissing) {
      // Prefer signal sections + core blocks when the explicit list must be bounded.
      const priority = new Set(['logs', 'events', 'spans', 'diagnostic', 'resource', 'refs', 'configFingerprints']);
      const high = evidenceMissing.filter(x => priority.has(x));
      const low = evidenceMissing.filter(x => !priority.has(x));
      const room = Math.max(0, DIAG_BUNDLE_LIMITS.maxMissing - high.length);
      evidenceMissing = [...high, ...low.slice(0, room)].slice(0, DIAG_BUNDLE_LIMITS.maxMissing);
    }

    const body = {
      schemaVersion: DIAG_BUNDLE_SCHEMA_VERSION,
      contractVersion: DIAG_BUNDLE_CONTRACT.version,
      correlation,
      policy: skeleton.policy,
      diagnostic,
      resource,
      refs,
      configFingerprints,
      logs: picked.logs,
      events: picked.events,
      spans: picked.spans,
      evidenceMissing,
      dropped: dropSummary,
    };

    let canonical = stableStringify(body);
    let usedBytes = canonical.length + 64; // integrity envelope headroom
    const exceeded = usedBytes > policy.maxBundleBytes;
    body.budget = {
      maxBytes: policy.maxBundleBytes,
      usedBytes,
      exceeded: exceeded || usedBytes > DIAG_BUNDLE_LIMITS.maxWireBytes,
    };
    // Re-serialize after budget stamp.
    canonical = stableStringify(body);
    if (canonical.length > DIAG_BUNDLE_LIMITS.maxWireBytes) return null;
    if (containsSecretShape(body)) return null;

    const digest = contentDigest(canonical);
    const bundle = {
      ...body,
      integrity: { alg: 'fnv1a-pair-v1', digest },
    };

    let wire;
    try { wire = JSON.stringify(bundle); } catch { return null; }
    if (wire === undefined || wire.length > DIAG_BUNDLE_LIMITS.maxWireBytes) return null;
    if (containsSecretShape(bundle)) return null;
    return Object.freeze(bundle);
  } catch {
    return null;
  }
}

/** Recompute integrity over a bundle body; returns digest string or null. */
export function verifyBundleIntegrity(bundle) {
  try {
    if (!isPlain(bundle)) return null;
    if (!isPlain(bundle.integrity)) return null;
    if (bundle.integrity.alg !== 'fnv1a-pair-v1') return null;
    if (typeof bundle.integrity.digest !== 'string' ||
        !bundle.integrity.digest.startsWith('BDL:v1:')) return null;
    if (bundle.schemaVersion !== DIAG_BUNDLE_SCHEMA_VERSION) return null;
    if (bundle.contractVersion !== DIAG_BUNDLE_CONTRACT.version) return null;
    const body = bundleBody(bundle);
    const canonical = stableStringify(body);
    const expected = contentDigest(canonical);
    if (expected !== bundle.integrity.digest) return null;
    if (containsSecretShape(bundle)) return null;
    return bundle.integrity.digest;
  } catch {
    return null;
  }
}

/** Export choke: wire bytes + integrity stamp (recomputed so export is always fresh). */
export function exportDiagnosticBundle(bundle) {
  try {
    if (!isPlain(bundle)) return null;
    const { integrity: _omit, ...rest } = bundle;
    if (!isPlain(rest)) return null;
    // Recompute digest from body — export never trusts a stale/tampered stamp.
    const canonical = stableStringify(rest);
    if (containsSecretShape(rest)) return null;
    const out = { ...rest, integrity: { alg: 'fnv1a-pair-v1', digest: contentDigest(canonical) } };
    const wire = JSON.stringify(out);
    if (wire === undefined || wire.length > DIAG_BUNDLE_LIMITS.maxWireBytes) return null;
    if (containsSecretShape(out)) return null;
    return wire;
  } catch {
    return null;
  }
}

/**
 * Import choke: parse wire, revalidate schema + integrity. Tampered or
 * malformed bundles return null (fail closed).
 */
export function importDiagnosticBundle(wire) {
  try {
    if (typeof wire !== 'string' || wire.length === 0) return null;
    if (wire.length > DIAG_BUNDLE_LIMITS.maxWireBytes) return null;
    let parsed;
    try { parsed = JSON.parse(wire); } catch { return null; }
    if (!isPlain(parsed)) return null;
    const allowed = [
      'schemaVersion', 'contractVersion', 'correlation', 'policy', 'diagnostic',
      'resource', 'refs', 'configFingerprints', 'logs', 'events', 'spans',
      'evidenceMissing', 'dropped', 'budget', 'integrity',
    ];
    if (Reflect.ownKeys(parsed).some(k => !allowed.includes(k))) return null;
    if (verifyBundleIntegrity(parsed) === null) return null;
    return Object.freeze(parsed);
  } catch {
    return null;
  }
}
