/** P9.5 semantic event contract. Product owner agent-6; implementation delegate
 * Agent 4 (Issue #101). Published vocabulary, versioned schemas, bounded
 * lifecycle events and an explicit duplicate/out-of-order policy. Depends only
 * on the P9.1 envelope: no P3/P4/P6/P8 import, no I/O, no clock, no exporter,
 * no remote call. Every admission path fails softly with null; unknown event
 * names and unsupported schema versions never admit.
 */
import { createTelemetryContext, createTelemetryRecord, serializeTelemetryRecord } from './telemetry-envelope.mjs';

export const SEMANTIC_EVENT_CONTRACT = Object.freeze({
  id: 'observability.semantic-event', version: '1.0.0', owner: 'agent-6',
});
export const EVENT_SCHEMA_VERSION = '1.0.0';
export const EVENT_LIMITS = Object.freeze({
  attributes: 8, eventNameBytes: 64, wireBytes: 12288, orderKeyBytes: 128, orderKeys: 65536,
});
/** Allowlist shared with P9.2 structured logs: numeric/boolean facts only. */
export const EVENT_ATTRIBUTE_FIELDS = Object.freeze([
  'durationMs', 'attempt', 'itemCount', 'byteCount', 'statusCode', 'cacheHit',
]);
/**
 * Published event vocabulary. Names quote lifecycle OUTCOMES at the P3
 * execution/checkpoint, P4 trigger/ingress and P6 node/registry/runtime
 * boundaries without importing or redefining those domains. Adding or renaming
 * a name is a contract version decision, never an ad-hoc producer string.
 */
export const EVENT_VOCABULARY = Object.freeze([
  Object.freeze({ name: "execution.started", domain: 'execution', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "execution.completed", domain: 'execution', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "execution.failed", domain: 'execution', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "execution.cancelled", domain: 'execution', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "checkpoint.created", domain: 'checkpoint', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "checkpoint.resumed", domain: 'checkpoint', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "trigger.received", domain: 'trigger', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "trigger.failed", domain: 'trigger', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "ingress.admitted", domain: 'ingress', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "ingress.rejected", domain: 'ingress', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "ingress.deferred", domain: 'ingress', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "ingress.duplicate", domain: 'ingress', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "ingress.rate_limited", domain: 'ingress', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "node.loaded", domain: 'node', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "node.quarantined", domain: 'node', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "node.released", domain: 'node', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "registry.epoch_published", domain: 'registry', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "registry.epoch_rolled_back", domain: 'registry', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "runtime.lease_acquired", domain: 'runtime', schemaVersion: EVENT_SCHEMA_VERSION }),
  Object.freeze({ name: "runtime.lease_released", domain: 'runtime', schemaVersion: EVENT_SCHEMA_VERSION }),
]);
const vocabulary = new Map(EVENT_VOCABULARY.map(entry => [entry.name, entry]));
export const EVENT_DOMAINS = Object.freeze([...new Set(EVENT_VOCABULARY.map(entry => entry.domain))]);
/**
 * Explicit duplicate/out-of-order policies for per-key lifecycle sequences.
 * monotonic: sequence must be > last accepted; equal is duplicate, less is
 * out_of_order. unordered: any nonnegative sequence admits; duplicates and
 * ordering are the consumer's concern. Both are bounded by maxKeys.
 */
export const EVENT_ORDER_POLICIES = Object.freeze(['monotonic', 'unordered']);
export const EVENT_ORDER_DECISIONS = Object.freeze([
  'accepted', 'duplicate', 'out_of_order', 'capacity', 'rejected',
]);
const fields = Object.freeze([
  'timestamp', 'eventName', 'schemaVersion', 'sequence', 'severity',
  'component', 'environment', 'operation', 'outcome',
  'errorCode', 'errorClass', 'artifactRef', 'diagnosticRef', 'attributes',
]);
const wireFields = Object.freeze(['contractVersion', 'eventName', 'schemaVersion', 'sequence', 'envelope', 'attributes']);
const events = new WeakSet();
function plain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function shape(value, allowed) {
  if (!plain(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= allowed.length && keys.every(key => allowed.includes(key) &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

/** Exact published name + exact published schema version; anything else fails closed. */
export function classifyEventVersion(eventName, schemaVersion) {
  try {
    if (typeof eventName !== 'string' || eventName.length === 0 ||
        eventName.length > EVENT_LIMITS.eventNameBytes) return 'unknown_event';
    const entry = vocabulary.get(eventName);
    if (!entry) return 'unknown_event';
    if (schemaVersion !== entry.schemaVersion) return 'unsupported_version';
    return 'supported';
  } catch { return 'unknown_event'; }
}

function safeAttributes(input) {
  if (input === undefined) return { values: Object.freeze({}), redactionCount: 0 };
  if (!plain(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length > EVENT_LIMITS.attributes) return null;
  let redactionCount = 0;
  for (const key of keys) {
    // Unknown names (or non-string keys) are counted as redacted; their
    // values are never read.
    if (typeof key !== 'string' || key.length > 64 || !EVENT_ATTRIBUTE_FIELDS.includes(key)) {
      redactionCount++;
      continue;
    }
  }
  // Emit in fixed allowlist order so wire identity is independent of the
  // producer's key insertion order (same rule as P9.2 structured logs).
  const values = {};
  for (const key of EVENT_ATTRIBUTE_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) continue;
    if (!('value' in descriptor) || !descriptor.enumerable) return null;
    const value = descriptor.value;
    if (key === 'cacheHit') {
      if (typeof value !== 'boolean') return null;
      values[key] = value;
    } else if (!Number.isSafeInteger(value) || value < 0 ||
        (key === 'statusCode' && (value < 100 || value > 599))) return null;
    else values[key] = value;
  }
  return Object.freeze({ values: Object.freeze(values), redactionCount });
}

/**
 * Bounded lifecycle event admission over a validated P9.1 context.
 * Required: published eventName, envelope timestamp, component (envelope rule).
 * schemaVersion defaults to the published version; any mismatch rejects.
 * Optional sequence is a nonnegative safe integer (ordering metadata only).
 * No message text, payload, artifact bytes, stack, header bag or unknown field
 * is captured; artifact/diagnostic references stay opaque envelope identifiers.
 */
export function createSemanticEvent(spec, context) {
  try {
    if (!shape(spec, fields) || typeof spec.eventName !== 'string' ||
        spec.eventName.length === 0 || spec.eventName.length > EVENT_LIMITS.eventNameBytes) return null;
    const entry = vocabulary.get(spec.eventName);
    if (!entry) return null;
    const schemaVersion = spec.schemaVersion === undefined ? entry.schemaVersion : spec.schemaVersion;
    if (schemaVersion !== entry.schemaVersion) return null;
    if (spec.sequence !== undefined &&
        (!Number.isSafeInteger(spec.sequence) || spec.sequence < 0)) return null;
    const attributes = safeAttributes(spec.attributes);
    if (!attributes) return null;
    const envelope = createTelemetryRecord({
      timestamp: spec.timestamp, signalType: 'EVENT', severity: spec.severity,
      component: spec.component, environment: spec.environment, operation: spec.operation,
      outcome: spec.outcome, errorCode: spec.errorCode, errorClass: spec.errorClass,
      artifactRef: spec.artifactRef, diagnosticRef: spec.diagnosticRef,
    }, context);
    if (!envelope) return null;
    const event = {
      contractVersion: SEMANTIC_EVENT_CONTRACT.version,
      eventName: spec.eventName,
      schemaVersion,
    };
    if (spec.sequence !== undefined) event.sequence = spec.sequence;
    event.envelope = envelope;
    event.attributes = attributes.values;
    event.redactionCount = attributes.redactionCount;
    Object.freeze(event);
    events.add(event);
    return event;
  } catch { return null; }
}

/** Slow path: deterministic field order, exact versions, no I/O, size-bounded.
 * redactionCount is admission-local bookkeeping and never appears on the wire.
 */
export function serializeSemanticEvent(event) {
  try {
    if (!events.has(event)) return null;
    const envelope = serializeTelemetryRecord(event.envelope);
    if (envelope === null) return null;
    const wire = `{\"contractVersion\":\"${SEMANTIC_EVENT_CONTRACT.version}\",\"eventName\":${JSON.stringify(event.eventName)},\"schemaVersion\":${JSON.stringify(event.schemaVersion)},` +
      (Object.hasOwn(event, 'sequence') ? `\"sequence\":${event.sequence},` : '') +
      `\"envelope\":${envelope},\"attributes\":${JSON.stringify(event.attributes)}}`;
    return wire.length <= EVENT_LIMITS.wireBytes ? wire : null;
  } catch { return null; }
}

/**
 * Slow path: bounded ASCII JSON, canonical encoding only. Unknown contract
 * versions, unknown event names and unsupported schema versions all return
 * null — no migration, no partial admission, no reinterpretation. Tenant
 * capture on decode requires the same explicit P9.1 policy authorization.
 */
export function deserializeSemanticEvent(wire, policy = undefined) {
  try {
    if (typeof wire !== 'string' || wire.length > EVENT_LIMITS.wireBytes ||
        /[^\x20-\x7e]/.test(wire)) return null;
    const raw = JSON.parse(wire);
    if (!plain(raw) || raw.contractVersion !== SEMANTIC_EVENT_CONTRACT.version) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.length > wireFields.length || !keys.every(key => wireFields.includes(key) &&
        Object.getOwnPropertyDescriptor(raw, key)?.enumerable &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key), 'value'))) return null;
    if (classifyEventVersion(raw.eventName, raw.schemaVersion) !== 'supported') return null;
    if (!plain(raw.envelope) || raw.envelope.signalType !== 'EVENT') return null;
    const attributes = safeAttributes(raw.attributes);
    if (!attributes || JSON.stringify(attributes.values) !== JSON.stringify(raw.attributes)) return null;
    const context = createTelemetryContext(raw.envelope.context, policy);
    if (!context) return null;
    const spec = {
      eventName: raw.eventName, schemaVersion: raw.schemaVersion,
      timestamp: raw.envelope.timestamp, severity: raw.envelope.severity,
      component: raw.envelope.component, environment: raw.envelope.environment,
      operation: raw.envelope.operation, outcome: raw.envelope.outcome,
      errorCode: raw.envelope.errorCode, errorClass: raw.envelope.errorClass,
      artifactRef: raw.envelope.artifactRef, diagnosticRef: raw.envelope.diagnosticRef,
      attributes: raw.attributes,
    };
    if (Object.hasOwn(raw, 'sequence')) spec.sequence = raw.sequence;
    const event = createSemanticEvent(spec, context);
    return event && serializeSemanticEvent(event) === wire ? event : null;
  } catch { return null; }
}

/**
 * Bounded per-key sequence gate for duplicate/out-of-order handling.
 * maxKeys is required (no default unbounded map). New keys beyond the budget
 * answer 'capacity'; invalid key/sequence answers 'rejected'. Under monotonic,
 * equal sequence is 'duplicate' and a lower sequence is 'out_of_order'.
 */
export function createEventOrderGate(config) {
  try {
    if (!shape(config, ['maxKeys', 'policy']) ||
        !Number.isSafeInteger(config.maxKeys) || config.maxKeys < 1 ||
        config.maxKeys > EVENT_LIMITS.orderKeys) return null;
    const policy = config.policy === undefined ? 'monotonic' : config.policy;
    if (!EVENT_ORDER_POLICIES.includes(policy)) return null;
    const last = new Map();
    const counts = { accepted: 0, duplicate: 0, out_of_order: 0, capacity: 0, rejected: 0 };
    function bump(decision) { counts[decision]++; return decision; }
    function observe(key, sequence) {
      try {
        if (typeof key !== 'string' || key.length === 0 || key.length > EVENT_LIMITS.orderKeyBytes ||
            !Number.isSafeInteger(sequence) || sequence < 0) return bump('rejected');
        if (last.has(key)) {
          const previous = last.get(key);
          if (policy === 'monotonic') {
            if (sequence === previous) return bump('duplicate');
            if (sequence < previous) return bump('out_of_order');
          }
          last.set(key, sequence);
          return bump('accepted');
        }
        if (last.size >= config.maxKeys) return bump('capacity');
        last.set(key, sequence);
        return bump('accepted');
      } catch { return bump('rejected'); }
    }
    function stats() {
      return Object.freeze({ ...counts, keys: last.size, maxKeys: config.maxKeys, policy });
    }
    return Object.freeze({ observe, stats, policy: policy, maxKeys: config.maxKeys });
  } catch { return null; }
}
