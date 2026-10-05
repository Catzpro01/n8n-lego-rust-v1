/** P9.2 structured logs, product owner agent-6; implementation delegate Agent 4.
 * No sink, console, remote call or disk write. Existing logger.mjs is unchanged.
 * The existing error catalog is read once by its foundation module at import,
 * never during log creation. P9 does not define new business error codes.
 */
import { ERROR_CODES, ERROR_CONTRACT_VERSION } from './errors.mjs';
import { TELEMETRY_SEVERITIES, createTelemetryRecord, serializeTelemetryRecord } from './telemetry-envelope.mjs';

export const STRUCTURED_LOG_CONTRACT = Object.freeze({
  id: `observability.structured-log`, version: '1.0.0', owner: 'agent-6',
});
export const LOG_LIMITS = Object.freeze({ attributes: 8, messageInputChars: 2048, wireBytes: 12288 });
export const LOG_ERROR_CLASSES = Object.freeze([
  'AUTHENTICATION', 'AUTHORIZATION', 'VALIDATION', 'NOT_FOUND', 'CONFLICT',
  'CAPACITY', 'CANCELLATION', 'TIMEOUT', 'UNAVAILABLE', 'INTERNAL', 'UNSUPPORTED',
]);
const STATUS_CLASS = Object.freeze({
  400: 'VALIDATION', 401: 'AUTHENTICATION', 403: 'AUTHORIZATION', 404: 'NOT_FOUND',
  409: 'CONFLICT', 413: 'CAPACITY', 429: 'CAPACITY', 499: 'CANCELLATION',
  500: 'INTERNAL', 501: 'UNSUPPORTED', 503: 'UNAVAILABLE', 504: 'TIMEOUT',
});
// Explicit exceptions preserve existing code meaning instead of parsing a message.
const CODE_CLASS = Object.freeze({
  'execution.timeout': 'TIMEOUT', 'node.catalog_unavailable': 'UNAVAILABLE',
  'storage.unavailable': 'UNAVAILABLE',
});
export const LOG_ERROR_TAXONOMY = Object.freeze({
  version: '1.0.0', sourceContractVersion: ERROR_CONTRACT_VERSION,
  entries: Object.freeze(ERROR_CODES.map(entry => Object.freeze({
    code: entry.code, errorClass: CODE_CLASS[entry.code] ?? STATUS_CLASS[entry.status] ?? null,
    retryable: typeof entry.retryable === 'boolean' ? entry.retryable : null,
  }))),
});
const errors = new Map(LOG_ERROR_TAXONOMY.entries.map(entry => [entry.code, entry]));
const attributes = Object.freeze(['durationMs', 'attempt', 'itemCount', 'byteCount', 'statusCode', 'cacheHit']);
const fields = Object.freeze([
  'timestamp', 'severity', 'component', 'environment', 'operation', 'outcome',
  'errorCode', 'artifactRef', 'diagnosticRef', 'attributes', 'message',
]);
const logs = new WeakSet();
function shape(value, allowed) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) return false;
  return keys.every(key => allowed.includes(key) && Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

/** Unknown code/type fails closed; no new code, source message or retry policy. */
export function classifyLogError(code) {
  if (typeof code !== 'string' || code.length === 0 || code.length > 128) return null;
  const entry = errors.get(code);
  return entry?.errorClass ? entry : null;
}

/**
 * Structured identity is mandatory. Optional message is NEVER captured (even
 * "safe-looking" text): its presence only increments redactionCount. Attributes
 * are an allowlist of numeric/boolean facts. Unknown attribute names/values are
 * removed without reading their values. Top-level unknown fields reject the log.
 * This narrow P9.2 redaction policy is not the general P9.7 classification engine.
 */
export function createStructuredLog(spec, context) {
  try {
    if (!shape(spec, fields) || !TELEMETRY_SEVERITIES.includes(spec.severity) ||
        typeof spec.operation !== 'string' || typeof spec.outcome !== 'string') return null;
    let redactionCount = 0;
    if (spec.message !== undefined) {
      if (typeof spec.message !== 'string' || spec.message.length > LOG_LIMITS.messageInputChars) return null;
      redactionCount++;
    }
    let errorClass;
    if (spec.errorCode !== undefined) {
      const error = classifyLogError(spec.errorCode);
      if (!error) return null;
      errorClass = error.errorClass;
    }
    const safeAttributes = {};
    if (spec.attributes !== undefined) {
      const input = spec.attributes;
      if (!input || typeof input !== 'object') return null;
      const proto = Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null) return null;
      const keys = Reflect.ownKeys(input);
      if (keys.length > LOG_LIMITS.attributes) return null;
      // No attacker-controlled names or secret values survive this pass.
      for (const key of keys) {
        if (typeof key !== 'string' || key.length > 64) return null;
        if (!attributes.includes(key)) redactionCount++;
      }
      for (const key of attributes) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor) continue;
        if (!('value' in descriptor) || !descriptor.enumerable) return null;
        const value = descriptor.value;
        if (key === 'cacheHit') {
          if (typeof value !== 'boolean') return null;
        } else if (!Number.isSafeInteger(value) || value < 0 ||
            (key === 'statusCode' && (value < 100 || value > 599))) return null;
        safeAttributes[key] = value;
      }
    }
    const envelope = createTelemetryRecord({
      timestamp: spec.timestamp, signalType: 'LOG', severity: spec.severity,
      component: spec.component, environment: spec.environment, operation: spec.operation,
      outcome: spec.outcome, errorCode: spec.errorCode, errorClass,
      artifactRef: spec.artifactRef, diagnosticRef: spec.diagnosticRef,
    }, context);
    if (!envelope) return null;
    const log = Object.freeze({ contractVersion: STRUCTURED_LOG_CONTRACT.version,
      envelope, attributes: Object.freeze(safeAttributes), redactionCount });
    logs.add(log);
    return log;
  } catch { return null; }
}

/** Only admitted logs can reach this slow-path codec; no persistence/export here. */
export function serializeStructuredLog(log) {
  try {
    if (!logs.has(log)) return null;
    const envelope = serializeTelemetryRecord(log.envelope);
    if (envelope === null) return null;
    const wire = `{"contractVersion":"${STRUCTURED_LOG_CONTRACT.version}","envelope":${envelope},"attributes":${JSON.stringify(log.attributes)},"redactionCount":${log.redactionCount}}`;
    return wire.length <= LOG_LIMITS.wireBytes ? wire : null;
  } catch { return null; }
}
