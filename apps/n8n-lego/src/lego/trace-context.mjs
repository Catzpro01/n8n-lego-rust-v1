/** P9.4 trace propagation. Product owner Agent 6, delegate Agent 4.
 * IDs supplied by producers; no entropy, clock, network, payload or runtime I/O.
 */
import { TELEMETRY_CONTEXT_FIELDS, deriveTelemetryContext } from './telemetry-envelope.mjs';
export const TRACE_CONTRACT = Object.freeze({ id: `observability.trace`, version: '1.0.0', owner: 'agent-6' });
export const TRACE_WIRE_VERSION = '00';
export const TRACE_LIMITS = Object.freeze({ traceIdChars: 32, spanIdChars: 16, traceparentChars: 55 });
const spans = new WeakSet();
const rootFields = ['traceId','spanId','parentSpanId','sampled'];
const childFields = TELEMETRY_CONTEXT_FIELDS.filter(k => !['workflowId','workflowVersion','executionId','correlationId','tenantId','traceId','spanId','parentSpanId'].includes(k));
function shape(value, fields) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= fields.length && keys.every(k => fields.includes(k) &&
    Object.getOwnPropertyDescriptor(value,k)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'));
}
function hexId(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value) && !/^0+$/.test(value);
}

/** Root/continuation constructor. No silent reassignment to a different trace. */
export function createTraceSpan(spec, baseContext, policy = undefined) {
  try {
    if (!shape(spec,rootFields) || !hexId(spec.traceId,32) || !hexId(spec.spanId,16) ||
        (spec.parentSpanId !== undefined && (!hexId(spec.parentSpanId,16) || spec.parentSpanId === spec.spanId)) ||
        (spec.sampled !== undefined && typeof spec.sampled !== 'boolean')) return null;
    // derive validates the private P9.1 context brand before any base field read.
    const context = deriveTelemetryContext(baseContext, { traceId: spec.traceId, spanId: spec.spanId, parentSpanId: spec.parentSpanId }, policy);
    if (!context || (baseContext.traceId !== undefined && baseContext.traceId !== spec.traceId) ||
        (baseContext.spanId !== undefined && baseContext.spanId !== spec.parentSpanId)) return null;
    const span = Object.freeze({ contractVersion: TRACE_CONTRACT.version, context, sampled: spec.sampled ?? false });
    spans.add(span);
    return span;
  } catch { return null; }
}

/** Preserve execution/tenant/correlation identity; only child-local references may change. */
export function createChildTraceSpan(parent, spanId, changes = {}, policy = undefined) {
  try {
    if (!spans.has(parent) || !shape(changes,childFields)) return null;
    const base = deriveTelemetryContext(parent.context,changes,policy);
    if (!base) return null;
    return createTraceSpan({traceId:parent.context.traceId,spanId,parentSpanId:parent.context.spanId,sampled:parent.sampled},base,policy);
  } catch { return null; }
}

/** Fixed 55-byte W3C traceparent v00 carrier, not a network client. */
export function injectTraceParent(span) {
  if (!spans.has(span)) return null;
  return `${TRACE_WIRE_VERSION}-${span.context.traceId}-${span.context.spanId}-${span.sampled ? '01' : '00'}`;
}

/** Supported subset: v00, lowercase nonzero IDs, flags 00/01; all else fail closed. */
export function parseTraceParent(header) {
  if (typeof header !== 'string' || header.length !== TRACE_LIMITS.traceparentChars) return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/.exec(header);
  if (!match || !hexId(match[1],32) || !hexId(match[2],16)) return null;
  return Object.freeze({ traceId: match[1], spanId: match[2], sampled: match[3] === '01' });
}

/** A received header names the REMOTE parent, never the new local span itself.
 * Header provides no workflow/tenant/auth authority: trusted baseContext does.
 */
export function continueTrace(header, localSpanId, baseContext, policy = undefined) {
  const remote = parseTraceParent(header);
  if (!remote) return null;
  return createTraceSpan({ traceId: remote.traceId, spanId: localSpanId, parentSpanId: remote.spanId, sampled: remote.sampled },baseContext,policy);
}

/** Pure reported metadata, not a payload hashing/capture function. Unknown data
 * fields reject without reading their contents. A hash grants no read authority.
 */
export function createTracePayloadReference(spec) {
  try {
    if (!shape(spec,['sha256','sizeBytes']) || typeof spec.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(spec.sha256) || !Number.isSafeInteger(spec.sizeBytes) || spec.sizeBytes < 0) return null;
    return Object.freeze({sha256:spec.sha256,sizeBytes:spec.sizeBytes});
  } catch { return null; }
}
