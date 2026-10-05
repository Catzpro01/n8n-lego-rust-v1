/**
 * P9.1 native telemetry contract. Product owner agent-6; implementation delegate
 * Agent 4 (Issue #101). No runtime imports, I/O, clock, exporter or payloads.
 * All admission APIs fail softly with null. Codec functions are slow-path only.
 */
export const TELEMETRY_CONTRACT = Object.freeze({
  id: `observability.envelope`, version: '1.0.0', owner: 'agent-6',
});
export const TELEMETRY_LIMITS = Object.freeze({ identifierBytes: 128, wireBytes: 8192 });
export const TELEMETRY_SIGNALS = Object.freeze(['LOG', 'METRIC', 'TRACE', 'EVENT', 'RESOURCE', 'DIAGNOSTIC']);
export const TELEMETRY_SEVERITIES = Object.freeze(['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
export const TELEMETRY_CONTEXT_FIELDS = Object.freeze([
  'workflowId', 'workflowVersion', 'executionId', 'nodeId', 'nodeType', 'nodeVersion',
  'triggerId', 'requestId', 'correlationId', 'causationId', 'traceId', 'spanId',
  'parentSpanId', 'checkpointId', 'runtimeId', 'registryEpoch', 'runtimeLeaseId',
  'resourceBudgetId', 'tenantId',
]);
const RECORD_FIELDS = Object.freeze([
  'timestamp', 'signalType', 'severity', 'component', 'environment', 'operation',
  'outcome', 'errorCode', 'errorClass', 'artifactRef', 'diagnosticRef',
]);
const WIRE_FIELDS = Object.freeze(['contractVersion', ...RECORD_FIELDS, 'context']);
const contexts = new WeakSet();
const records = new WeakSet();
const identifiers = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
// Defense in depth, not a universal secret detector. Only trusted opaque IDs
// belong here; names, URLs, raw headers, bodies, messages and stacks do not.
const secretLike = /(?:gh[pousr]_|github_pat_|sk[-_](?:live|test|proj)[-_]|AKIA[A-Z0-9]{12}|eyJ[A-Za-z0-9_-]*\.|-----BEGIN|password[:=]|secret[:=]|token[:=]|authorization[:=])/i;
function identifier(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= TELEMETRY_LIMITS.identifierBytes && identifiers.test(value) &&
    !value.includes('://') && !secretLike.test(value);
}

// Reject extra fields, symbols, accessors and custom prototypes before reading
// values. No traversal of field values; no JSON work on the producer path.
function shape(value, fields) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > fields.length) return false;
  for (const key of keys) {
    if (!fields.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}
function permittedTenant(value, policy) {
  return value === undefined || (identifier(value) && policy?.authorizedTenantId === value);
}

/**
 * Cold-boundary construction. A successful result is immutable and reusable.
 * policy.authorizedTenantId must come from the caller's existing authorization
 * boundary, NOT from request data. Absence means tenant capture denied.
 */
export function createTelemetryContext(spec = {}, policy = undefined) {
  try {
    if (!shape(spec, TELEMETRY_CONTEXT_FIELDS) || !permittedTenant(spec.tenantId, policy)) return null;
    const result = {};
    for (const key of TELEMETRY_CONTEXT_FIELDS) {
      const value = spec[key];
      if (value === undefined) continue;
      if (key === 'registryEpoch') {
        if (!Number.isSafeInteger(value) || value < 0) return null;
      } else if (!identifier(value)) return null;
      result[key] = value;
    }
    Object.freeze(result);
    contexts.add(result);
    return result;
  } catch { return null; }
}

/** Derive a local child without copying business state; explicit tenant reauthorization. */
export function deriveTelemetryContext(parent, changes = {}, policy = undefined) {
  try {
    if (!contexts.has(parent) || !shape(changes, TELEMETRY_CONTEXT_FIELDS)) return null;
    return createTelemetryContext({ ...parent, ...changes }, policy);
  } catch { return null; }
}

/**
 * Project ONLY foundation envelope correlation fields. Never copy actor/scope,
 * idempotencyKey, AbortSignal or arbitrary business fields. No getter invocation.
 */
export function telemetryContextFromEnvelope(envelope) {
  try {
    if (!envelope || typeof envelope !== 'object') return null;
    const context = {};
    for (const key of ['requestId', 'correlationId', 'causationId', 'traceId']) {
      const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
      if (!descriptor) continue;
      if (!('value' in descriptor)) return null;
      if (descriptor.value !== null && descriptor.value !== undefined) context[key] = descriptor.value;
    }
    return createTelemetryContext(context);
  } catch { return null; }
}

/**
 * Tiny native record constructor: caller supplies timestamp (epoch milliseconds)
 * and a prevalidated context. No clock read, JSON, stack, payload clone or sink
 * callback. Consumers decide whether/how to buffer later. Invalid input => null.
 */
export function createTelemetryRecord(spec, context) {
  try {
    if (!contexts.has(context) || !shape(spec, RECORD_FIELDS)) return null;
    if (!Number.isSafeInteger(spec.timestamp) || spec.timestamp < 0 ||
        !TELEMETRY_SIGNALS.includes(spec.signalType) || !identifier(spec.component)) return null;
    if (spec.severity !== undefined && !TELEMETRY_SEVERITIES.includes(spec.severity)) return null;
    const record = { contractVersion: TELEMETRY_CONTRACT.version };
    for (const key of RECORD_FIELDS) {
      const value = spec[key];
      if (value === undefined) continue;
      if (!['timestamp', 'signalType', 'severity'].includes(key) && !identifier(value)) return null;
      record[key] = value;
    }
    record.context = context;
    Object.freeze(record);
    records.add(record);
    return record;
  } catch { return null; }
}

/** Slow path: deterministic field order; rejects forged objects; no I/O. */
export function serializeTelemetryRecord(record) {
  try {
    if (!records.has(record)) return null;
    const wire = JSON.stringify(record);
    return wire.length <= TELEMETRY_LIMITS.wireBytes ? wire : null;
  } catch { return null; }
}

/**
 * Slow path: bounded ASCII JSON input, exact version, unknown fields rejected.
 * Only canonical encodings are accepted (also rejects duplicate JSON keys).
 * This is a native wire codec, not OTLP or arbitrary JSON ingestion.
 */
export function deserializeTelemetryRecord(wire, policy = undefined) {
  try {
    if (typeof wire !== 'string' || wire.length > TELEMETRY_LIMITS.wireBytes || /[^\x20-\x7e]/.test(wire)) return null;
    const raw = JSON.parse(wire);
    if (!shape(raw, WIRE_FIELDS) || raw.contractVersion !== TELEMETRY_CONTRACT.version) return null;
    const context = createTelemetryContext(raw.context, policy);
    if (!context || !Object.hasOwn(raw, 'context')) return null;
    const spec = {};
    for (const key of RECORD_FIELDS) if (Object.hasOwn(raw, key)) spec[key] = raw[key];
    const record = createTelemetryRecord(spec, context);
    return record && serializeTelemetryRecord(record) === wire ? record : null;
  } catch { return null; }
}
