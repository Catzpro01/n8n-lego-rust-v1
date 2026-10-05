/**
 * Backend LEGO foundation — the universal transport & envelope kernel (P2.18).
 *
 * PUBLIC CONTRACT (`lego.transport-kernel`, v1.0.0, owner: agent-1).
 *
 * ONE BOUNDED SHAPE FOR EVERY BOUNDARY: CALL / EVENT / STREAM / BATCH messages
 * travel as a deterministic encoding of `{ envelope, payload }`. This module is
 * the codec plus the fail-closed gate — it deliberately contains NO transport:
 * no HTTP, no broker, no daemon, no queue of its own. Dispatch stays in
 * `interaction.mjs`; operation context stays in `envelope.mjs`. A future
 * adapter encodes with this kernel and moves bytes however it likes, and the
 * receiving side gets the same validation every time.
 *
 * THE FOUR ACCEPTANCE PROPERTIES (P2.18):
 *   1. Round-trip determinism — the same logical message always encodes to the
 *      exact same string (recursively sorted keys, no whitespace), and
 *      decode(encode(x)) deep-equals x for every plain-JSON payload.
 *   2. Malformed fail-closed — a truncated, mistyped, unknown-keyed, circular,
 *      lossy or oversize message is refused with `lego.contract_violation`,
 *      never repaired speculatively.
 *   3. Propagation, not re-invention — correlation / causation / trace /
 *      deadline / cancellation / idempotency fields pass through untouched;
 *      `signal` still cannot cross the wire (the `cancellable` flag says so).
 *   4. Bounds before throughput — message bytes, identifier lengths, JSON depth
 *      and every queue live under a declared ceiling in `KERNEL_LIMITS`.
 *
 * What this is NOT: an HTTP server, a message broker, a persistence layer,
 * model inference, a credential manager or an approval runtime (P2.19+).
 */
import {
  ENVELOPE_FIELDS,
  serializeEnvelope,
  deserializeEnvelope,
} from './envelope.mjs';

/** Declared bounds for one encoded message. Raise deliberately, never by accident. */
export const KERNEL_LIMITS = Object.freeze({
  /** Hard ceiling on one encoded message, in UTF-8 bytes. */
  maxMessageBytes: 64 * 1024,
  /** Ceiling for every identifier-shaped envelope string (ids, versions, keys). */
  maxIdLength: 128,
  /** Ceiling for JSON nesting during payload validation — bounds the validator itself. */
  maxJsonDepth: 32,
});

/**
 * A fail-closed kernel refusal. Carries the published `lego.contract_violation`
 * code so consumers branch on `code`, never on message text.
 */
export class KernelViolationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'KernelViolationError';
    this.code = 'lego.contract_violation';
    this.retryable = false;
    this.details = Object.freeze({ ...details });
  }
}

function violation(message, details = {}) {
  throw new KernelViolationError(message, details);
}

const WIRE_ENVELOPE_FIELDS = Object.freeze(ENVELOPE_FIELDS.filter((field) => field !== 'signal'));

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk a value that must survive a lossless JSON round trip. Rejects anything
 * JSON would silently change (functions, undefined, NaN, Dates, class
 * instances, symbols, BigInt, circular refs) and enforces the depth ceiling.
 */
function assertPlainJson(value, path, seen, depth = 0) {
  if (depth > KERNEL_LIMITS.maxJsonDepth) {
    violation(`payload exceeds KERNEL_LIMITS.maxJsonDepth (${KERNEL_LIMITS.maxJsonDepth}) at '${path}'`, { path, limit: 'maxJsonDepth' });
  }
  if (value === null) return;
  const type = typeof value;
  if (type === 'boolean' || type === 'string') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      violation(`payload contains a non-finite number at '${path}' — the codec would lose it`, { path });
    }
    return;
  }
  if (type !== 'object') {
    violation(`payload contains a ${type} at '${path}' — only plain JSON values survive the wire`, { path, type });
  }
  if (seen.has(value)) {
    violation(`payload is circular at '${path}'`, { path });
  }
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (propertyIsEnumerable(value, symbol)) {
      violation(`payload has an enumerable symbol key at '${path}' — JSON would drop it`, { path });
    }
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertPlainJson(value[index], `${path}[${index}]`, seen, depth + 1);
    }
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertPlainJson(entry, `${path}.${key}`, seen, depth + 1);
    }
  } else {
    violation(`payload contains a non-plain object at '${path}' (Date, Map, class instance, ...) — serialize it explicitly first`, { path });
  }
  seen.delete(value);
}

function propertyIsEnumerable(value, symbol) {
  return Object.prototype.propertyIsEnumerable.call(value, symbol);
}

function assertIdentifier(value, name, { nullable = false } = {}) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > KERNEL_LIMITS.maxIdLength) {
    violation(`wire envelope.${name} must be a non-empty string of at most ${KERNEL_LIMITS.maxIdLength} characters`, { field: name });
  }
}

/**
 * Validate a WIRE envelope (the shape after `serializeEnvelope`): every
 * declared field present with its declared type, no `signal`, no unknown keys.
 * Throws `KernelViolationError` on the first problem — malformed is rejected,
 * never repaired.
 */
export function validateEnvelope(plain) {
  if (!isPlainObject(plain)) {
    violation('wire envelope must be a plain object', { field: 'envelope' });
  }
  for (const key of Object.keys(plain)) {
    if (key === 'signal') {
      violation('wire envelope must not carry a signal — an AbortSignal cannot cross a process boundary', { field: 'signal' });
    }
    if (key !== 'cancellable' && !WIRE_ENVELOPE_FIELDS.includes(key)) {
      violation(`wire envelope declares unknown field '${key}'`, { field: key });
    }
  }
  for (const field of WIRE_ENVELOPE_FIELDS) {
    if (!(field in plain)) {
      violation(`wire envelope is missing '${field}'`, { field });
    }
  }
  assertIdentifier(plain.legoId, 'legoId');
  assertIdentifier(plain.operation, 'operation');
  assertIdentifier(plain.requestId, 'requestId');
  assertIdentifier(plain.correlationId, 'correlationId');
  assertIdentifier(plain.causationId, 'causationId', { nullable: true });
  assertIdentifier(plain.traceId, 'traceId', { nullable: true });
  assertIdentifier(plain.idempotencyKey, 'idempotencyKey', { nullable: true });
  assertIdentifier(plain.contractVersion, 'contractVersion', { nullable: true });
  if (plain.deadline !== null && (typeof plain.deadline !== 'number' || !Number.isFinite(plain.deadline))) {
    violation('wire envelope.deadline must be a finite number or null', { field: 'deadline' });
  }
  if (plain.cancellable !== undefined && typeof plain.cancellable !== 'boolean') {
    violation('wire envelope.cancellable must be a boolean when present', { field: 'cancellable' });
  }
  const seen = new Set();
  if (plain.actor !== null) {
    if (!isPlainObject(plain.actor)) violation('wire envelope.actor must be a plain object or null', { field: 'actor' });
    assertPlainJson(plain.actor, 'envelope.actor', seen, 0);
  }
  if (plain.scope !== null) {
    if (!isPlainObject(plain.scope)) violation('wire envelope.scope must be a plain object or null', { field: 'scope' });
    assertPlainJson(plain.scope, 'envelope.scope', seen, 0);
  }
  return plain;
}

/**
 * Deterministic JSON: recursively sorted keys, no whitespace. Only called on
 * values that already passed `assertPlainJson`, so every input encodes to
 * exactly one canonical string.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * Encode one message (envelope + payload) to its canonical wire string.
 * Deterministic: key order of the inputs cannot change the output.
 *
 * @param {object} envelope in-memory envelope (its `signal` is dropped, as at every boundary)
 * @param {*} payload plain-JSON payload — lossy values are refused, not silently dropped
 * @returns {string} canonical JSON of `{ envelope, payload }`
 */
export function encodeMessage(envelope, payload) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    violation('encodeMessage requires an envelope object', { field: 'envelope' });
  }
  const seen = new Set();
  assertPlainJson(payload, 'payload', seen, 0);
  const wire = serializeEnvelope(envelope);
  validateEnvelope(wire);
  const text = stableStringify({ envelope: wire, payload });
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > KERNEL_LIMITS.maxMessageBytes) {
    violation(`message is ${bytes} bytes, beyond KERNEL_LIMITS.maxMessageBytes=${KERNEL_LIMITS.maxMessageBytes}`, { bytes, limit: 'maxMessageBytes' });
  }
  return text;
}

/**
 * Decode and validate one canonical wire string. Fail-closed on every axis:
 * size (checked before parsing), JSON syntax, envelope schema, payload depth.
 * Cancellation is re-established by the receiving side via `signal`.
 *
 * @param {string} text output of {@link encodeMessage} (or an equivalent hand-built message)
 * @param {{ signal?: AbortSignal|null }} [options]
 */
export function decodeMessage(text, { signal = null } = {}) {
  if (typeof text !== 'string') {
    violation('decodeMessage requires the encoded message string', { field: 'message' });
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > KERNEL_LIMITS.maxMessageBytes) {
    violation(`message is ${bytes} bytes, beyond KERNEL_LIMITS.maxMessageBytes=${KERNEL_LIMITS.maxMessageBytes} — refusing to parse`, { bytes, limit: 'maxMessageBytes' });
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    violation(`malformed message: not valid JSON (${String(error.message).slice(0, 80)})`, { bytes });
  }
  if (!isPlainObject(message)) {
    violation('malformed message: top level must be an object { envelope, payload }', {});
  }
  const keys = Object.keys(message);
  for (const key of keys) {
    if (key !== 'envelope' && key !== 'payload') {
      violation(`malformed message: unknown top-level field '${key}'`, { field: key });
    }
  }
  if (!('envelope' in message) || !('payload' in message)) {
    violation('malformed message: both envelope and payload are required', {});
  }
  validateEnvelope(message.envelope);
  const seen = new Set();
  assertPlainJson(message.payload, 'payload', seen, 0);
  const envelope = deserializeEnvelope(message.envelope, { signal });
  return Object.freeze({ envelope, payload: message.payload });
}
