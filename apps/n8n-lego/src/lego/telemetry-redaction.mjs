/** P9.7 telemetry redaction + data classification. Product owner agent-6;
 * implementation delegate Agent 4 (Issue #101). Defines the five data classes,
 * classifies fields/values fail-closed, sanitizes error messages, converts
 * binary/large data to bounded references, and redacts nested structures
 * BEFORE persistence or export. Raw request/response bodies are FORBIDDEN by
 * default. No I/O, no clock, no network — pure local functions so every
 * alternate telemetry path can route through the same boundary. Redaction is
 * not a justification to collect data that should never be collected: SECRET
 * and FORBIDDEN material is dropped, not summarized.
 */
export const REDACTION_CONTRACT = Object.freeze({
  id: 'observability.telemetry-redaction', version: '1.0.0', owner: 'agent-6',
});
/** #101 deep design §15 data classes, exact order least → most restricted. */
export const TELEMETRY_DATA_CLASSES = Object.freeze([
  'PUBLIC_DIAGNOSTIC', 'INTERNAL_DIAGNOSTIC', 'SENSITIVE', 'SECRET', 'FORBIDDEN',
]);
/** What the boundary does with a classified value. */
export const REDACTION_ACTIONS = Object.freeze(['allow', 'redact', 'reject', 'reference']);
export const REDACTION_LIMITS = Object.freeze({
  maxDepth: 8, maxNodes: 512, maxKeys: 64, maxKeyBytes: 128,
  maxStringBytes: 512, maxMessageBytes: 1024, maxArrayLength: 64,
});
export const REDACTION_MARKERS = Object.freeze({
  redacted: '[REDACTED]',
  secretValue: '[REDACTED:SECRET]',
  forbiddenValue: '[REDACTED:FORBIDDEN]',
  truncated: '[TRUNCATED]',
  binaryRef: 'binary_ref',
});
/**
 * Field-name patterns. FORBIDDEN covers raw bodies and authority handles that
 * must never enter telemetry even redacted (collection is the violation).
 * SECRET covers credential-shaped names. SENSITIVE covers PII-ish names
 * (policy-controlled: default redact under `allowPii: false`).
 */
const FORBIDDEN_KEY = /^(?:body|payload|rawBody|raw_body|requestBody|request_body|responseBody|response_body|httpBody|httpClientResponse|credentials|credential|privateKey|private_key|secretKey|secret_key|apiKey|api_key|password|passwd|token|authorization|auth|cookie|setCookie|set-cookie|sessionToken|bearer)$/i;
const SECRET_KEY = /(?:secret|password|passwd|credential|token|apikey|api[-_]key|private[-_]?key|passphrase|otp|client[-_]?secret|access[-_]?key)/i;
// Word-ish boundaries: short tokens (pan, tel, dob) must not hit inside
// ordinary diagnostics (`span`, `hotel`, `donate`…).
const SENSITIVE_KEY = /(?:^|[^a-z0-9])(?:email|e[-_]?mail|phone|tel|ssn|social[-_]?security|dob|birthdate|birth[-_]?date|address|fullname|full[-_]?name|firstname|first[-_]?name|lastname|last[-_]?name|ipaddr|ip[-_]?address|national[-_]?id|cardnumber|card[-_]?number|pan|cvv)(?:$|[^a-z0-9])/i;
/**
 * Value shapes: real secret-shaped strings (tokens, JWTs, PEM, Basic/Bearer,
 * cloud keys) regardless of the key they hide under. Nested secrets are caught
 * here even when the key looks innocent (e.g. `value`, `note`, `header`).
 */
const SECRET_VALUE = new RegExp([
  'gh[pousr]_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'sk[-_](?:live|test|proj)[-_][A-Za-z0-9]{8,}',
  'AKIA[0-9A-Z]{16}',
  'eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}',
  '-----BEGIN[ A-Z]*PRIVATE KEY-----',
  '(?:Bearer|Basic)\\s+[A-Za-z0-9+/=._-]{8,}',
  '(?:password|secret|token|api[-_]?key|authorization)\\s*[:=]\\s*\\S{4,}',
].join('|'), 'i');
const BODY_KEY = /^(?:body|payload|rawBody|raw_body|requestBody|request_body|responseBody|response_body|httpBody)$/i;
function plain(value) {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function byteLength(text) {
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}
/**
 * Classify one field by name + value. Fail-closed: unknown/scanner hits climb
 * the class ladder; a FORBIDDEN name or raw-body key wins over everything.
 * Returns a frozen { class, action, reason } — never the original value.
 */
export function classifyTelemetryField(key, value) {
  try {
    const name = typeof key === 'string' ? key : '';
    if (BODY_KEY.test(name) || FORBIDDEN_KEY.test(name)) {
      return Object.freeze({ class: 'FORBIDDEN', action: 'reject', reason: 'forbidden_field' });
    }
    // Value scanners run even when the key looks innocent (nested secrets).
    if (typeof value === 'string' && value.length > 0 && SECRET_VALUE.test(value)) {
      return Object.freeze({ class: 'SECRET', action: 'redact', reason: 'secret_shaped_value' });
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer ||
        (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(value))) {
      return Object.freeze({ class: 'INTERNAL_DIAGNOSTIC', action: 'reference', reason: 'binary_reference' });
    }
    if (SECRET_KEY.test(name)) {
      return Object.freeze({ class: 'SECRET', action: 'redact', reason: 'secret_field_name' });
    }
    if (SENSITIVE_KEY.test(name)) {
      return Object.freeze({ class: 'SENSITIVE', action: 'redact', reason: 'sensitive_field_name' });
    }
    // Primitive diagnostics under neutral names stay internal/public by policy.
    if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      return Object.freeze({ class: 'PUBLIC_DIAGNOSTIC', action: 'allow', reason: 'scalar_diagnostic' });
    }
    if (typeof value === 'string') {
      return Object.freeze({ class: 'INTERNAL_DIAGNOSTIC', action: 'allow', reason: 'bounded_string' });
    }
    if (plain(value) || Array.isArray(value)) {
      return Object.freeze({ class: 'INTERNAL_DIAGNOSTIC', action: 'allow', reason: 'nested_container' });
    }
    // Functions, symbols, undefined, class instances: not serializable diagnostics.
    return Object.freeze({ class: 'FORBIDDEN', action: 'reject', reason: 'non_diagnostic_value' });
  } catch {
    return Object.freeze({ class: 'FORBIDDEN', action: 'reject', reason: 'classification_error' });
  }
}
/**
 * Sanitize a free-text error message BEFORE it can enter any telemetry path.
 * Secret-shaped spans become markers; output is bounded; never throws.
 * This does NOT make arbitrary prose safe to capture — callers still choose
 * whether a message is collected at all (P9.2 omits messages entirely).
 */
export function sanitizeErrorMessage(message, options = undefined) {
  try {
    if (typeof message !== 'string') return null;
    const opts = options && typeof options === 'object' ? options : {};
    const maxBytes = Number.isSafeInteger(opts.maxMessageBytes) && opts.maxMessageBytes > 0 &&
      opts.maxMessageBytes <= REDACTION_LIMITS.maxMessageBytes * 4
      ? opts.maxMessageBytes : REDACTION_LIMITS.maxMessageBytes;
    if (message.length > maxBytes * 4) return null; // refuse pathological input up front
    // Fresh global copy: SECRET_VALUE stays non-global so .test() is not
    // subject to lastIndex drift across calls; replace must hit every span.
    let out = message.replace(new RegExp(SECRET_VALUE.source, 'gi'), REDACTION_MARKERS.secretValue);
    if (byteLength(out) > maxBytes) out = out.slice(0, maxBytes) + REDACTION_MARKERS.truncated;
    return out;
  } catch { return null; }
}
function redactNode(value, depth, state, opts) {
  if (state.nodes >= REDACTION_LIMITS.maxNodes || depth > REDACTION_LIMITS.maxDepth) {
    state.truncated = true;
    return REDACTION_MARKERS.truncated;
  }
  state.nodes++;
  if (value === null) return null;
  // Idempotent markers: re-redacting an already-redacted export is a no-op
  // (bypass resistance: redactForExport(redactForExport(x)) changes nothing).
  if (value === REDACTION_MARKERS.redacted || value === REDACTION_MARKERS.secretValue ||
      value === REDACTION_MARKERS.forbiddenValue || value === REDACTION_MARKERS.truncated) {
    return value;
  }
  const kind = classifyTelemetryField(state.key, value);
  if (kind.action === 'reject') {
    state.redactions++;
    state.counts[kind.class] = (state.counts[kind.class] ?? 0) + 1;
    return kind.class === 'FORBIDDEN' ? REDACTION_MARKERS.forbiddenValue : REDACTION_MARKERS.redacted;
  }
  if (kind.action === 'redact') {
    // Policy-controlled SENSITIVE names: allowPii opts in; SECRET never does.
    if (kind.class === 'SENSITIVE' && opts.allowPii === true) {
      if (typeof value === 'string') return value;
    } else {
      state.redactions++;
      state.counts[kind.class] = (state.counts[kind.class] ?? 0) + 1;
      return kind.class === 'SECRET' ? REDACTION_MARKERS.secretValue : REDACTION_MARKERS.redacted;
    }
  }
  if (kind.action === 'reference') {
    state.references++;
    const bytes = value instanceof ArrayBuffer ? value.byteLength : value.byteLength ?? value.length ?? 0;
    return Object.freeze({ [REDACTION_MARKERS.binaryRef]: true, bytes });
  }
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) {
      state.redactions++;
      state.counts.SECRET = (state.counts.SECRET ?? 0) + 1;
      return REDACTION_MARKERS.secretValue;
    }
    if (byteLength(value) > REDACTION_LIMITS.maxStringBytes) {
      state.truncated = true;
      return value.slice(0, REDACTION_LIMITS.maxStringBytes) + REDACTION_MARKERS.truncated;
    }
    if (opts.allowPii !== true && SENSITIVE_KEY.test(state.key || '')) {
      state.redactions++;
      state.counts.SENSITIVE = (state.counts.SENSITIVE ?? 0) + 1;
      return REDACTION_MARKERS.redacted;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const n = Math.min(value.length, REDACTION_LIMITS.maxArrayLength);
    if (value.length > n) state.truncated = true;
    const out = [];
    for (let i = 0; i < n; i++) {
      const prevKey = state.key;
      state.key = prevKey;
      out.push(redactNode(value[i], depth + 1, state, opts));
      state.key = prevKey;
    }
    return out;
  }
  if (plain(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.length > REDACTION_LIMITS.maxKeys) state.truncated = true;
    const out = {};
    let emitted = 0;
    for (const key of keys) {
      if (emitted >= REDACTION_LIMITS.maxKeys) { state.truncated = true; break; }
      if (typeof key !== 'string' || key.length > REDACTION_LIMITS.maxKeyBytes) {
        state.redactions++;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        // Accessor: never invoke. FORBIDDEN/SECRET field names still emit a
        // marker from the name alone; other accessors are omitted entirely.
        state.rejectedAccessors++;
        const nameOnly = classifyTelemetryField(key, '');
        if (nameOnly.class === 'FORBIDDEN' && nameOnly.action === 'reject') {
          state.redactions++;
          state.counts.FORBIDDEN = (state.counts.FORBIDDEN ?? 0) + 1;
          out[key] = REDACTION_MARKERS.forbiddenValue;
        } else if (nameOnly.class === 'SECRET' && nameOnly.action === 'redact') {
          state.redactions++;
          state.counts.SECRET = (state.counts.SECRET ?? 0) + 1;
          out[key] = REDACTION_MARKERS.secretValue;
        }
        continue;
      }
      const prevKey = state.key;
      state.key = key;
      // Already a marker: idempotent pass-through (no re-count).
      if (descriptor.value === REDACTION_MARKERS.redacted ||
          descriptor.value === REDACTION_MARKERS.secretValue ||
          descriptor.value === REDACTION_MARKERS.forbiddenValue ||
          descriptor.value === REDACTION_MARKERS.truncated) {
        out[key] = descriptor.value;
        state.key = prevKey;
        emitted++;
        continue;
      }
      const child = classifyTelemetryField(key, descriptor.value);
      // FORBIDDEN keys are not traversed — their values are never read.
      if (child.action === 'reject' && child.class === 'FORBIDDEN') {
        state.redactions++;
        state.counts.FORBIDDEN = (state.counts.FORBIDDEN ?? 0) + 1;
        out[key] = child.reason === 'forbidden_field' ? REDACTION_MARKERS.forbiddenValue : REDACTION_MARKERS.redacted;
        state.key = prevKey;
        emitted++;
        continue;
      }
      out[key] = redactNode(descriptor.value, depth + 1, state, opts);
      state.key = prevKey;
      emitted++;
    }
    return out;
  }
  // Functions/symbols/undefined never enter the redacted tree.
  state.redactions++;
  state.counts.FORBIDDEN = (state.counts.FORBIDDEN ?? 0) + 1;
  return REDACTION_MARKERS.redacted;
}
/**
 * Redact an arbitrary diagnostic structure BEFORE persistence/export.
 * Walks nested objects/arrays with depth, node, key, array and string bounds.
 * FORBIDDEN field values (bodies, credential bags) are replaced without being
 * read. Deterministic and pure: same input → same output (bypass resistance
 * relies on every export path calling this exact function).
 */
export function redactTelemetryTree(root, options = undefined) {
  try {
    if (root === undefined) return null;
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.allowRaw === true) {
      // Explicit opt-in cannot enable SECRET/FORBIDDEN collection — only PII names.
      // Raw bodies remain forbidden: redaction is not a collection license.
    }
    const state = {
      key: '', nodes: 0, redactions: 0, references: 0, truncated: 0,
      rejectedAccessors: 0, counts: {},
    };
    const value = redactNode(root, 0, state, opts);
    return Object.freeze({
      contractVersion: REDACTION_CONTRACT.version,
      value: deepFreeze(value),
      redactionCount: state.redactions,
      referenceCount: state.references,
      truncated: state.truncated > 0,
      classCounts: Object.freeze({ ...state.counts }),
    });
  } catch { return null; }
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
/**
 * Export-boundary redaction: the single choke point every exporter/store must
 * call. Accepts a plain diagnostic object (log body, event payload snapshot,
 * incident field bag) and returns a frozen redacted envelope. Rejects
 * non-plain roots (raw strings with secrets go through sanitizeErrorMessage;
 * binary roots become references only when wrapped by the caller).
 */
export function redactForExport(payload, options = undefined) {
  try {
    if (payload === undefined || payload === null) return null;
    if (!plain(payload) && !Array.isArray(payload)) {
      if (typeof payload === 'string') {
        const message = sanitizeErrorMessage(payload, options);
        if (message === null) return null;
        return Object.freeze({
          contractVersion: REDACTION_CONTRACT.version,
          value: message,
          redactionCount: message.includes(REDACTION_MARKERS.secretValue) ? 1 : 0,
          referenceCount: 0,
          truncated: message.endsWith(REDACTION_MARKERS.truncated),
          classCounts: Object.freeze(message.includes(REDACTION_MARKERS.secretValue) ? { SECRET: 1 } : {}),
        });
      }
      return null;
    }
    const result = redactTelemetryTree(payload, options);
    if (!result) return null;
    // Export MUST NOT retain FORBIDDEN/SECRET payloads; markers only.
    return result;
  } catch { return null; }
}
/** Self-check used by tests and the contract oracle: no secret shapes remain. */
export function containsSecretShape(value) {
  try {
    if (typeof value === 'string') return SECRET_VALUE.test(value);
    if (Array.isArray(value)) return value.some(containsSecretShape);
    if (plain(value)) {
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') continue;
        if (SECRET_KEY.test(key) || FORBIDDEN_KEY.test(key)) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor && 'value' in descriptor && descriptor.value !== REDACTION_MARKERS.secretValue &&
              descriptor.value !== REDACTION_MARKERS.forbiddenValue && descriptor.value !== REDACTION_MARKERS.redacted) {
            return true;
          }
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && 'value' in descriptor && containsSecretShape(descriptor.value)) return true;
      }
      return false;
    }
    return false;
  } catch { return true; }
}
