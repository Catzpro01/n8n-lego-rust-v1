/**
 * Tool Provider Adapter — the first real tool-provider adapter (P2.25).
 *
 * PUBLIC CONTRACT (`ai.tool-gateway`, v1.0.0, owner: manager).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The adapter boundary that translates one explicitly configured external tool
 * provider onto the canonical tool gateway contract: `tools.list`,
 * `tool.describe`, `tool.call`, `resources.list`, `resource.read`,
 * `prompts.list`, `prompt.get` — quoted byte-for-byte from
 * `manifest/ai-foundation.json#toolGateway`. A generic provider configuration
 * is NEVER execution authority: consumers depend on the contract, the adapter
 * binds one declared provider, and every invocation is a separate,
 * explicitly authorized act.
 *
 * FIVE SEPARATE CONCEPTS (P2.25 §7) — never collapsed
 * ----------------------------------------------------
 *   tool declaration  — what the configuration declares (toolId, inputSchema,
 *                       sideEffects, availability …) — the canonical catalog;
 *   tool capability   — whether the capability is declared in the registry
 *                       (domains.json / negotiation) — never inferred here;
 *   tool permission   — `ai:tool:read` / `ai:tool:invoke`, named exactly at
 *                       call time (XA-8 consumed unchanged: `ai:*` quoted,
 *                       no new word, no reinterpretation);
 *   tool invocation   — one authorized, bounded, idempotent-by-requestId call;
 *   provider binding  — the explicit configuration + injected `exchange`.
 * Configuration or availability never implies any of the other four.
 *
 * THE CREDENTIAL BOUNDARY (§10)
 * -----------------------------
 * Credentials are NEVER stored by LEGO: configuration refuses credential
 * fields and credential-shaped values; the injected `exchange` binding is the
 * operator/application edge; errors carry canonical codes and bounded metadata
 * only — no raw provider body, no input echo, no key, no header.
 *
 * SIDE EFFECTS + IDEMPOTENCY (§27/§28)
 * -------------------------------------
 * `sideEffects` is REQUIRED and validated against the published vocabulary —
 * an undeclared or unknown effect is refused here (the gateway rule: unknown
 * means destructive, so the safe answer is rejection, not silence).
 * `tool.call` is NON-idempotent: exactly one exchange, never retried inside
 * the adapter, and it REQUIRES a `requestId`. A replay of the same requestId
 * with the same canonicalized payload returns the recorded outcome WITHOUT a
 * second exchange (results travel as opaque references — the full result is
 * never stored for replay); a different payload under the same requestId is
 * refused (`request-id-reuse`). The requestId also travels to the provider so
 * a real binding can dedupe on its side. Reads (`list`/`describe`) are
 * idempotent and also single-shot: there is no internal retry of any kind.
 *
 * HONEST USAGE (§14)
 * ------------------
 * Tool calls produce no token figures of their own — this adapter records
 * NOTHING into `ai.token-usage@1.0.0`. Model usage attribution stays with the
 * model adapter / the caller's accounting; inventing tool-side token counts
 * would be exactly the fabrication P2.24 forbids.
 *
 * DETERMINISM / DEPENDENCIES (§18/§19)
 * ------------------------------------
 * `now` and `newId` must be injected. All I/O is the injected `exchange`
 * binding; no `node:*` import, no network call, no added dependency.
 */

import { AI_FOUNDATION, AI_TRANSPORTS, TOOL_SIDE_EFFECTS } from './ai-foundation.mjs';
import { SENSITIVE_USAGE_RE } from './token-usage.mjs';

/* ---------------------------------------------------------------- contract */

export const TOOL_GATEWAY_CONTRACT = Object.freeze({
  id: "ai.tool-gateway",
  version: '1.0.0',
  owner: 'manager',
});

export const TOOL_GATEWAY_CONTRACT_VERSION = TOOL_GATEWAY_CONTRACT.version;

/** Operation names quoted from manifest#toolGateway — no synonym coined. */
export const TOOL_GATEWAY_OPERATIONS = Object.freeze(
  AI_FOUNDATION.toolGateway.operations.map((operation) => operation.name),
);

/** Permission words quoted from domains.json capability `ai.tool-gateway`. */
export const TOOL_GATEWAY_PERMISSIONS = Object.freeze([
  'ai:tool:invoke',
  'ai:tool:read',
]);

/**
 * Provider configuration/status vocabulary (P2.25 §22) — byte-identical to
 * `model-provider-adapter.mjs#PROVIDER_ADAPTER_STATES` (one vocabulary, two
 * modules, asserted equal by the focused suite; provider state is never
 * authority: `available` ≠ tool call permitted).
 */
export const PROVIDER_ADAPTER_STATES = Object.freeze([
  'not-configured',
  'configured',
  'available',
  'unavailable',
  'degraded',
  'disabled',
]);

/** Exchange error kinds → canonical codes (stable across providers, §13). */
export const PROVIDER_ERROR_TRANSLATION = Object.freeze({
  timeout: 'lego.deadline_exceeded',
  unavailable: 'lego.unavailable',
  'rate-limited': 'lego.backpressure',
  forbidden: 'lego.access_denied',
  cancelled: 'lego.cancelled',
});

/** Every canonical code this adapter may emit — quoted from errors.contract.json 1.2.0. */
export const TOOL_PROVIDER_ERROR_CODES = Object.freeze([
  'lego.contract_violation',
  'lego.access_denied',
  'lego.unavailable',
  'lego.deadline_exceeded',
  'lego.operation_unsupported',
  'lego.dependency_disabled',
  'lego.backpressure',
  'lego.cancelled',
]);

/** Bounds — every exchange dimension is finite (§27). */
export const TOOL_PROVIDER_LIMITS = Object.freeze({
  maxDeclaredTools: 128,
  maxListedTools: 256,
  maxResources: 256,
  maxPrompts: 256,
  maxAttemptsPerCall: 1,
  maxInputChars: 65_536,
  maxResultChars: 262_144,
  maxResourceChars: 262_144,
  maxTimeoutMs: 600_000,
  maxRequestIdLength: 128,
  maxEndpointLength: 128,
  maxDetailLength: 128,
  maxReplayEntries: 4096,
});

/** Declared operating modes a configuration may choose — no default is assumed. */
const DECLARED_AVAILABILITIES = Object.freeze(['available', 'degraded', 'disabled']);

/** Configuration fields that may never appear — LEGO stores no credentials (§10). */
const FORBIDDEN_CONFIG_FIELDS = Object.freeze([
  'apiKey', 'api_key', 'accessToken', 'access_token', 'token', 'bearer',
  'credential', 'credentials', 'authorization', 'auth', 'headers', 'header',
  'secret', 'password', 'cookie', 'privateKey', 'private_key', 'clientSecret',
]);

/* ------------------------------------------------------------------ errors */

export class ToolProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ToolProviderError';
    if (!TOOL_PROVIDER_ERROR_CODES.includes(code)) {
      throw new Error(`unknown tool-provider error code '${code}' — declare it in src/lego/contracts/errors.contract.json first`);
    }
    this.code = code;
    this.details = freezeDeep(sanitizeDetails(details));
  }
}

function fail(code, message, details = {}) {
  throw new ToolProviderError(code, message, details);
}

/* -------------------------------------------------------------- primitives */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const USAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;
const ABSOLUTE_PATH_RE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;

function freezeDeep(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Bounded, secret-scanned error metadata — never a raw provider body (§13). */
function sanitizeDetails(details) {
  if (!isPlainObject(details)) return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === 'string') {
      const sliced = value.length > TOOL_PROVIDER_LIMITS.maxDetailLength
        ? value.slice(0, TOOL_PROVIDER_LIMITS.maxDetailLength)
        : value;
      out[key] = SENSITIVE_USAGE_RE.test(sliced) ? '[redacted]' : sliced;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    }
  }
  return out;
}

function assertId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !ID_RE.test(value)) {
    fail('lego.contract_violation', `${field} must match ${ID_RE} (1..64 characters)`, { field });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail('lego.contract_violation', `${field} carries a credential-shaped value — the adapter never accepts, stores or forwards credentials`, {
      field,
      reason: 'credential-shaped-value',
    });
  }
  return value;
}

function assertOpaqueReference(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > TOOL_PROVIDER_LIMITS.maxEndpointLength
    || !REFERENCE_ID_RE.test(value) || TRAVERSAL_RE.test(value) || ABSOLUTE_PATH_RE.test(value)) {
    fail('lego.contract_violation', `${field} must be an opaque reference — path-shaped or over-long values are refused`, {
      field,
      reason: 'not-an-opaque-reference',
    });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail('lego.contract_violation', `${field} carries a credential-shaped value`, { field, reason: 'credential-shaped-value' });
  }
  return value;
}

function assertBoundedString(value, field, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (value.length === 0 && !allowEmpty) || value.length > maxLength) {
    fail('lego.contract_violation', `${field} must be a string of ${allowEmpty ? '0..' : '1..'}${maxLength} characters`, {
      field,
      limit: maxLength,
    });
  }
  return value;
}

/** Stable structural identity for replay comparison — sorted keys, no content echo. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function assertToolInput(input) {
  if (input === undefined) return null;
  const serialized = JSON.stringify(input);
  if (serialized === undefined) {
    fail('lego.contract_violation', 'input must be JSON-serializable', { field: 'input' });
  }
  if (serialized.length > TOOL_PROVIDER_LIMITS.maxInputChars) {
    fail('lego.contract_violation', `input is bounded at ${TOOL_PROVIDER_LIMITS.maxInputChars} serialized characters`, {
      field: 'input',
      limit: 'maxInputChars',
    });
  }
  return freezeDeep(input);
}

/* -------------------------------------------------------- config validation */

const TOOL_DECLARED_KEYS = new Set([
  'toolId', 'sideEffects', 'availability', 'inputSchema',
  'outputSchema', 'description', 'riskClass', 'requiresApproval', 'rateLimit',
]);

function validateToolEntry(entry, providerId, index) {
  if (!isPlainObject(entry)) {
    fail('lego.contract_violation', `tools[${index}] must be a plain object`, { field: `tools[${index}]` });
  }
  for (const key of Object.keys(entry)) {
    if (FORBIDDEN_CONFIG_FIELDS.includes(key)) {
      fail('lego.contract_violation', `'${key}' may never appear in a provider configuration — credentials are supplied per call and never stored`, {
        field: key,
        reason: 'credential-field-refused',
      });
    }
    if (!TOOL_DECLARED_KEYS.has(key)) {
      fail('lego.contract_violation', `unknown tool metadata field '${key}' — the declaration shape is the published toolMetadata vocabulary`, {
        field: key,
      });
    }
  }
  // toolMetadata.required: toolId, provider (adapter-filled), inputSchema, sideEffects, availability.
  for (const required of ['toolId', 'inputSchema', 'sideEffects', 'availability']) {
    if (entry[required] === undefined) {
      fail('lego.contract_violation', `tools[${index}].${required} is required — sideEffects in particular drives the approval contract`, {
        field: required,
      });
    }
  }
  assertId(entry.toolId, `tools[${index}].toolId`);
  if (!TOOL_SIDE_EFFECTS.includes(entry.sideEffects)) {
    // The gateway rule: an unknown effect must be treated as destructive — refused, never silently accepted.
    fail('lego.contract_violation', `tools[${index}].sideEffects must be one of ${TOOL_SIDE_EFFECTS.join(', ')} — unknown effects are treated as destructive and refused`, {
      field: 'sideEffects',
      received: String(entry.sideEffects).slice(0, 32),
    });
  }
  if (!DECLARED_AVAILABILITIES.includes(entry.availability)) {
    fail('lego.contract_violation', `tools[${index}].availability must be one of ${DECLARED_AVAILABILITIES.join(', ')}`, {
      field: 'availability',
    });
  }
  if (!isPlainObject(entry.inputSchema)) {
    fail('lego.contract_violation', `tools[${index}].inputSchema must be a plain object declaration`, { field: 'inputSchema' });
  }
  if (entry.outputSchema !== undefined && !isPlainObject(entry.outputSchema)) {
    fail('lego.contract_violation', `tools[${index}].outputSchema must be a plain object when present`, { field: 'outputSchema' });
  }
  if (entry.description !== undefined) {
    assertBoundedString(entry.description, `tools[${index}].description`, 1024, { allowEmpty: true });
    if (SENSITIVE_USAGE_RE.test(entry.description)) {
      fail('lego.contract_violation', 'description carries a credential-shaped value', { field: 'description', reason: 'credential-shaped-value' });
    }
  }
  if (entry.riskClass !== undefined && typeof entry.riskClass !== 'string') {
    fail('lego.contract_violation', 'riskClass must be a string when present', { field: 'riskClass' });
  }
  if (entry.requiresApproval !== undefined && typeof entry.requiresApproval !== 'boolean') {
    fail('lego.contract_violation', 'requiresApproval must be a boolean when present', { field: 'requiresApproval' });
  }
  if (entry.rateLimit !== undefined) {
    if (typeof entry.rateLimit !== 'string' && !(isPlainObject(entry.rateLimit))) {
      fail('lego.contract_violation', 'rateLimit must be a string or object when present', { field: 'rateLimit' });
    }
    if (typeof entry.rateLimit === 'string' && SENSITIVE_USAGE_RE.test(entry.rateLimit)) {
      fail('lego.contract_violation', 'rateLimit carries a credential-shaped value', { field: 'rateLimit', reason: 'credential-shaped-value' });
    }
  }
  return Object.freeze({ ...entry, provider: providerId });
}

function validateConfig(config) {
  if (!isPlainObject(config)) {
    fail('lego.contract_violation', 'config must be a plain object — there is no implicit provider', { field: 'config' });
  }
  for (const key of Object.keys(config)) {
    if (FORBIDDEN_CONFIG_FIELDS.includes(key)) {
      fail('lego.contract_violation', `'${key}' may never appear in a provider configuration — credentials are supplied per call and never stored, logged or echoed`, {
        field: key,
        reason: 'credential-field-refused',
      });
    }
  }
  // Closed shape: nothing outside the published provider-kind fields (§11 — no invented fields).
  for (const key of Object.keys(config)) {
    if (!['providerId', 'kind', 'availability', 'transport', 'endpoint', 'tools'].includes(key)) {
      fail('lego.contract_violation', `unknown configuration field '${key}' — the tool-provider config shape is closed`, { field: key });
    }
  }
  const required = AI_FOUNDATION.providerKinds['tool-provider'].required;
  for (const field of required) {
    if (config[field] === undefined) {
      fail('lego.contract_violation', `config.${field} is required — provider configuration is explicit (no default provider, no auto-discovery)`, {
        field,
        required,
      });
    }
  }
  assertId(config.providerId, 'config.providerId');
  if (config.kind !== 'tool-provider') {
    fail('lego.contract_violation', `unknown provider kind '${String(config.kind)}' — this adapter binds exactly 'tool-provider' (fail-closed)`, {
      field: 'kind',
      expected: 'tool-provider',
    });
  }
  if (!DECLARED_AVAILABILITIES.includes(config.availability)) {
    fail('lego.contract_violation', `config.availability must be one of ${DECLARED_AVAILABILITIES.join(', ')}`, { field: 'availability' });
  }
  if (!AI_TRANSPORTS.includes(config.transport)) {
    fail('lego.contract_violation', `config.transport must be one of ${AI_TRANSPORTS.join(', ')} — transport is quoted from the AI contract`, {
      field: 'transport',
    });
  }
  if (config.endpoint !== undefined) assertOpaqueReference(config.endpoint, `config.endpoint`);
  if (!Array.isArray(config.tools) || config.tools.length > TOOL_PROVIDER_LIMITS.maxDeclaredTools) {
    fail('lego.contract_violation', `config.tools must be an array of at most ${TOOL_PROVIDER_LIMITS.maxDeclaredTools} declared tools`, {
      field: 'tools',
      limit: 'maxDeclaredTools',
    });
  }
  const seen = new Set();
  const tools = config.tools.map((entry, index) => {
    const tool = validateToolEntry(entry, config.providerId, index);
    if (seen.has(tool.toolId)) {
      fail('lego.contract_violation', `duplicate declared tool '${tool.toolId}'`, { field: 'tools' });
    }
    seen.add(tool.toolId);
    return Object.freeze(tool);
  });
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && SENSITIVE_USAGE_RE.test(value)) {
      fail('lego.contract_violation', `config.${key} carries a credential-shaped value — the adapter never accepts credentials in configuration`, {
        field: key,
        reason: 'credential-shaped-value',
      });
    }
  }
  return Object.freeze({
    providerId: config.providerId,
    kind: config.kind,
    availability: config.availability,
    transport: config.transport,
    endpoint: config.endpoint ?? null,
    tools: Object.freeze(tools),
  });
}

/* ---------------------------------------------------------- authorization */

function requiredPermission(operation) {
  const entry = AI_FOUNDATION.toolGateway.operations.find((op) => op.name === operation);
  /* c8 ignore next */
  if (!entry) fail('lego.operation_unsupported', `operation '${operation}' is not part of ai.tool-gateway`, { operation });
  return entry.permission;
}

function authorize(authorization, operation, { requireGrant }) {
  const required = requiredPermission(operation);
  if (!isPlainObject(authorization)) {
    fail('lego.access_denied', 'call-time authorization handoff is required — a configured tool provider grants nothing by existing', {
      operation,
      required,
      reason: 'authorization-handoff-missing',
    });
  }
  for (const key of Object.keys(authorization)) {
    if (!['permission', 'grantReference'].includes(key)) {
      fail('lego.contract_violation', `unknown authorization field '${key}' — the handoff shape is closed`, { field: key });
    }
  }
  if (authorization.permission !== required) {
    fail('lego.access_denied', `authorization must name the published permission '${required}' exactly — no synonym, no reinterpretation`, {
      operation,
      required,
      received: typeof authorization.permission === 'string' ? authorization.permission : null,
      reason: 'permission-mismatch',
    });
  }
  if (requireGrant) {
    if (authorization.grantReference === undefined || authorization.grantReference === null) {
      fail('lego.access_denied', 'tool invocation requires an explicit grantReference — configuration is not authority', {
        operation,
        required,
        reason: 'grant-reference-missing',
      });
    }
    assertOpaqueReference(authorization.grantReference, 'authorization.grantReference');
  } else if (authorization.grantReference !== undefined && authorization.grantReference !== null) {
    assertOpaqueReference(authorization.grantReference, 'authorization.grantReference');
  }
}

/* ------------------------------------------------------- exchange boundary */

function mapTransportError(error) {
  if (error && typeof error.code === 'string' && TOOL_PROVIDER_ERROR_CODES.includes(error.code)) {
    return error.code;
  }
  if (error && typeof error.kind === 'string' && PROVIDER_ERROR_TRANSLATION[error.kind]) {
    return PROVIDER_ERROR_TRANSLATION[error.kind];
  }
  if (error && (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT')) {
    return 'lego.deadline_exceeded';
  }
  return 'lego.unavailable';
}

function validateTimeout(timeoutMs, { required }) {
  if (timeoutMs === undefined || timeoutMs === null) {
    if (required) {
      fail('lego.contract_violation', 'timeoutMs is required for provider invoke operations — every exchange carries an explicit deadline budget', {
        field: 'timeoutMs',
      });
    }
    return null;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TOOL_PROVIDER_LIMITS.maxTimeoutMs) {
    fail('lego.contract_violation', `timeoutMs must be an integer in [1, ${TOOL_PROVIDER_LIMITS.maxTimeoutMs}]`, {
      field: 'timeoutMs',
      limit: 'maxTimeoutMs',
    });
  }
  return timeoutMs;
}

function validateRequestIdShape(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > TOOL_PROVIDER_LIMITS.maxRequestIdLength || !USAGE_ID_RE.test(value)) {
    fail('lego.contract_violation', `requestId must be a bounded identifier (1..${TOOL_PROVIDER_LIMITS.maxRequestIdLength} chars)`, { field: 'requestId' });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail('lego.contract_violation', 'requestId carries a credential-shaped value', { field: 'requestId', reason: 'credential-shaped-value' });
  }
  return value;
}

/* ---------------------------------------------------------------- adapter */

function canonicalTool(entry) {
  const tool = {
    toolId: entry.toolId,
    provider: entry.provider,
    inputSchema: entry.inputSchema,
    sideEffects: entry.sideEffects,
    availability: entry.availability,
  };
  for (const key of ['outputSchema', 'description', 'riskClass', 'requiresApproval', 'rateLimit']) {
    if (entry[key] !== undefined) tool[key] = entry[key];
  }
  return Object.freeze(tool);
}

function assertIdList(values, { field, maxItems, idField }) {
  if (!Array.isArray(values) || values.length > maxItems) {
    fail('lego.contract_violation', `${field} must be an array of at most ${maxItems} entries`, { field, limit: maxItems });
  }
  const seen = new Set();
  for (const entry of values) {
    if (!isPlainObject(entry) || typeof entry[idField] !== 'string') {
      fail('lego.contract_violation', `malformed provider response — each ${field} entry needs a ${idField}`, { field, idField });
    }
    const id = entry[idField];
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      fail('lego.contract_violation', `malformed provider response — ${field} entry ${idField} must be a bounded identifier`, { field, idField });
    }
    if (SENSITIVE_USAGE_RE.test(id)) {
      fail('lego.contract_violation', `${field} entry carries a credential-shaped ${idField}`, { field, reason: 'credential-shaped-value' });
    }
    if (seen.has(id)) {
      fail('lego.contract_violation', `malformed provider response — duplicate ${field} entry '${id}'`, { field });
    }
    seen.add(id);
  }
  return values;
}

function assertContent(content, field, maxChars) {
  return assertBoundedString(content, field, maxChars);
}

export function createToolProviderAdapter({ config, exchange, now, newId } = {}) {
  if (typeof now !== 'function' || typeof newId !== 'function') {
    throw new ToolProviderError('lego.contract_violation', 'now and newId must be injected (no ambient clock, no ambient id)', {});
  }
  if (typeof exchange !== 'function') {
    fail('lego.contract_violation', 'exchange must be a function — the adapter edge is an injected binding, never a baked-in transport', {
      field: 'exchange',
    });
  }
  const conf = validateConfig(config);
  // One clock read at creation (ISO fail-fast); status/metadata never touch an ambient clock.
  const configuredAtRaw = String(now());
  if (Number.isNaN(Date.parse(configuredAtRaw))) {
    fail('lego.contract_violation', 'now() must return an ISO timestamp', { field: 'now' });
  }
  const configuredAt = new Date(configuredAtRaw).toISOString();
  const adapterId = String(newId()).slice(0, 64);
  if (adapterId.length === 0) {
    fail('lego.contract_violation', 'newId() must return a non-empty identifier', { field: 'newId' });
  }

  const declaredById = new Map(conf.tools.map((tool) => [tool.toolId, tool]));
  /** requestId → recorded outcome. Opaque references only — never a result body (§23). */
  const replay = new Map();
  let state = conf.availability === 'disabled' ? 'disabled'
    : conf.availability === 'degraded' ? 'degraded'
      : 'configured';
  let lastError = null;

  function noteSuccess() {
    state = conf.availability === 'degraded' ? 'degraded' : 'available';
    lastError = null;
  }

  function noteFailure(code) {
    if (state !== 'disabled') state = 'unavailable';
    lastError = code;
  }

  function refuseDisabled(operation) {
    if (state === 'disabled') {
      fail('lego.dependency_disabled', `provider '${conf.providerId}' is declared disabled — a disabled provider is registered but not callable`, {
        operation,
        providerId: conf.providerId,
      });
    }
  }

  async function exchangeOnce(operation, request, details) {
    try {
      return await exchange(freezeDeep(request));
    } catch (error) {
      const code = mapTransportError(error);
      noteFailure(code);
      // The provider's own message/body is NEVER echoed (§13).
      fail(code, `provider exchange failed for '${operation}' (${code})`, { operation, providerId: conf.providerId, ...details });
      /* c8 ignore next */
      return undefined;
    }
  }

  function requireDeclaredTool(toolId, operation) {
    const declared = declaredById.get(toolId);
    if (!declared) {
      fail('lego.operation_unsupported', `tool '${toolId}' is not declared for this provider — unknown tools fail closed, never inferred`, {
        operation,
        toolId,
        reason: 'tool-not-declared',
      });
    }
    if (declared.availability === 'disabled') {
      fail('lego.operation_unsupported', `tool '${toolId}' is declared disabled`, {
        operation,
        toolId,
        reason: 'tool-disabled',
      });
    }
    return declared;
  }

  const adapter = Object.freeze({
    providerId: conf.providerId,
    contract: TOOL_GATEWAY_CONTRACT_VERSION,

    /** Provider configuration/status (§22) — same six states as the model adapter. */
    status() {
      return Object.freeze({
        adapterId,
        configuredAt,
        providerId: conf.providerId,
        configuration: 'configured',
        state,
        lastError,
        declaredAvailability: conf.availability,
        transport: conf.transport,
        endpoint: conf.endpoint,
        toolIds: Object.freeze(conf.tools.map((tool) => tool.toolId)),
      });
    },

    /**
     * tools.list — idempotent read. The canonical catalog is the DECLARATION;
     * the provider confirms liveness: only declared ∩ confirmed tools are
     * listed (a provider may never introduce a tool this configuration did
     * not declare).
     */
    async toolsList({ authorization } = {}) {
      refuseDisabled('tools.list');
      authorize(authorization, 'tools.list', { requireGrant: false });
      const response = await exchangeOnce('tools.list', {
        op: 'tools.list',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
      }, { operation: 'tools.list' });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — tools.list must answer with an object', { operation: 'tools.list' });
      }
      const confirmed = new Set(
        assertIdList(response.tools, { field: 'tools', maxItems: TOOL_PROVIDER_LIMITS.maxListedTools, idField: 'toolId' })
          .map((entry) => entry.toolId),
      );
      const tools = conf.tools
        .filter((tool) => confirmed.has(tool.toolId))
        .map((tool) => canonicalTool(tool));
      noteSuccess();
      return Object.freeze({ provider: conf.providerId, tools: Object.freeze(tools) });
    },

    /** tool.describe — canonical declaration of one confirmed tool. */
    async toolDescribe({ authorization, toolId } = {}) {
      refuseDisabled('tool.describe');
      authorize(authorization, 'tool.describe', { requireGrant: false });
      assertId(toolId, 'toolId');
      const declared = requireDeclaredTool(toolId, 'tool.describe');
      const response = await exchangeOnce('tool.describe', {
        op: 'tool.describe',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        toolId,
      }, { operation: 'tool.describe', toolId });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — tool.describe must answer with an object', { operation: 'tool.describe' });
      }
      if (response.toolId !== undefined && response.toolId !== toolId) {
        fail('lego.contract_violation', 'malformed provider response — describe answered for a different tool', {
          operation: 'tool.describe',
          field: 'toolId',
        });
      }
      noteSuccess();
      return Object.freeze({ tool: canonicalTool(declared), provider: conf.providerId });
    },

    /**
     * tool.call — NON-idempotent invoke: one exchange, never retried inside
     * the adapter, `requestId` required. Replay of the same requestId with
     * the same canonicalized payload answers the recorded outcome with no
     * second exchange; a different payload under the same requestId is
     * refused. `requiresApproval` tools must present an approval reference
     * (presence + shape enforced here; grant verification belongs to
     * ai.approval — this adapter never decides approvals).
     */
    async toolCall({ authorization, toolId, input, timeoutMs, requestId, approvalReference } = {}) {
      refuseDisabled('tool.call');
      authorize(authorization, 'tool.call', { requireGrant: true });
      assertId(toolId, 'toolId');
      const declared = requireDeclaredTool(toolId, 'tool.call');
      const safeInput = assertToolInput(input);
      const safeTimeout = validateTimeout(timeoutMs, { required: true });
      if (requestId === undefined || requestId === null) {
        fail('lego.contract_violation', 'requestId is required for tool.call — a side-effecting invocation needs an explicit identity', {
          field: 'requestId',
        });
      }
      const safeRequestId = validateRequestIdShape(requestId);
      const digest = canonicalJson({ toolId, input: safeInput ?? null });

      const prior = replay.get(safeRequestId);
      if (prior !== undefined) {
        if (prior.digest !== digest) {
          fail('lego.contract_violation', 'requestId was already executed with a different payload — identity reuse is refused, never overwritten', {
            operation: 'tool.call',
            field: 'requestId',
            reason: 'request-id-reuse',
          });
        }
        // Idempotent replay: outcome only, result body never stored (§23).
        return Object.freeze({
          toolId,
          provider: conf.providerId,
          outcome: prior.outcome,
          result: null,
          resultReference: prior.resultReference,
          errorReference: prior.errorReference,
          requestId: safeRequestId,
          replayed: true,
        });
      }

      if (declared.requiresApproval === true && (approvalReference === undefined || approvalReference === null)) {
        fail('lego.access_denied', `tool '${toolId}' declares requiresApproval — an approval reference must be presented (presence enforced here; ai.approval decides the grant)`, {
          operation: 'tool.call',
          toolId,
          reason: 'approval-reference-required',
        });
      }
      const safeApproval = assertOpaqueReference(approvalReference, 'approvalReference');

      const response = await exchangeOnce('tool.call', {
        op: 'tool.call',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        toolId,
        input: safeInput,
        sideEffects: declared.sideEffects,
        timeoutMs: safeTimeout,
        requestId: safeRequestId,
        approvalReference: safeApproval,
      }, { operation: 'tool.call', toolId });

      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — tool.call must answer with an object', { operation: 'tool.call' });
      }
      if (response.outcome !== 'succeeded' && response.outcome !== 'failed') {
        fail('lego.contract_violation', 'malformed provider response — outcome must be succeeded or failed', {
          operation: 'tool.call',
          field: 'outcome',
        });
      }
      const resultReference = assertOpaqueReference(response.resultReference, 'resultReference');
      const errorReference = assertOpaqueReference(response.errorReference, 'errorReference');
      let result = null;
      if (response.result !== undefined && response.result !== null) {
        result = assertToolInput(response.result);
        if (result !== null && JSON.stringify(result).length > TOOL_PROVIDER_LIMITS.maxResultChars) {
          fail('lego.contract_violation', `result is bounded at ${TOOL_PROVIDER_LIMITS.maxResultChars} serialized characters`, {
            field: 'result',
            limit: 'maxResultChars',
          });
        }
      }
      if (response.outcome === 'succeeded' && result === null && resultReference === null) {
        fail('lego.contract_violation', 'malformed provider response — a succeeded call needs a result or a resultReference', {
          operation: 'tool.call',
          field: 'result',
        });
      }

      if (replay.size >= TOOL_PROVIDER_LIMITS.maxReplayEntries) {
        fail('lego.backpressure', `the request-id replay cache is bounded at ${TOOL_PROVIDER_LIMITS.maxReplayEntries} entries`, {
          operation: 'tool.call',
          limit: 'maxReplayEntries',
        });
      }
      replay.set(safeRequestId, Object.freeze({
        digest,
        outcome: response.outcome,
        resultReference,
        errorReference,
      }));
      noteSuccess();
      return Object.freeze({
        toolId,
        provider: conf.providerId,
        outcome: response.outcome,
        result,
        resultReference,
        errorReference,
        requestId: safeRequestId,
        replayed: false,
      });
    },

    /** resources.list — idempotent read of the provider's resource catalog. */
    async resourcesList({ authorization } = {}) {
      refuseDisabled('resources.list');
      authorize(authorization, 'resources.list', { requireGrant: false });
      const response = await exchangeOnce('resources.list', {
        op: 'resources.list',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
      }, { operation: 'resources.list' });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — resources.list must answer with an object', { operation: 'resources.list' });
      }
      const entries = assertIdList(response.resources, { field: 'resources', maxItems: TOOL_PROVIDER_LIMITS.maxResources, idField: 'resourceId' });
      const resources = entries.map((entry) => Object.freeze({
        resourceId: entry.resourceId,
        ...(typeof entry.description === 'string' && entry.description.length <= 1024
          ? { description: SENSITIVE_USAGE_RE.test(entry.description) ? '[redacted]' : entry.description }
          : {}),
      }));
      noteSuccess();
      return Object.freeze({ provider: conf.providerId, resources: Object.freeze(resources) });
    },

    /** resource.read — idempotent read of one resource body (bounded). */
    async resourceRead({ authorization, resourceId } = {}) {
      refuseDisabled('resource.read');
      authorize(authorization, 'resource.read', { requireGrant: false });
      if (typeof resourceId !== 'string' || resourceId.length === 0 || resourceId.length > 64) {
        fail('lego.contract_violation', 'resourceId must be a bounded identifier (1..64 chars)', { field: 'resourceId' });
      }
      if (SENSITIVE_USAGE_RE.test(resourceId)) {
        fail('lego.contract_violation', 'resourceId carries a credential-shaped value', { field: 'resourceId', reason: 'credential-shaped-value' });
      }
      const response = await exchangeOnce('resource.read', {
        op: 'resource.read',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        resourceId,
      }, { operation: 'resource.read', resourceId });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — resource.read must answer with an object', { operation: 'resource.read' });
      }
      const content = assertContent(response.content, 'content', TOOL_PROVIDER_LIMITS.maxResourceChars);
      noteSuccess();
      return Object.freeze({ provider: conf.providerId, resourceId, content });
    },

    /** prompts.list — idempotent read of the provider's prompt catalog. */
    async promptsList({ authorization } = {}) {
      refuseDisabled('prompts.list');
      authorize(authorization, 'prompts.list', { requireGrant: false });
      const response = await exchangeOnce('prompts.list', {
        op: 'prompts.list',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
      }, { operation: 'prompts.list' });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — prompts.list must answer with an object', { operation: 'prompts.list' });
      }
      const entries = assertIdList(response.prompts, { field: 'prompts', maxItems: TOOL_PROVIDER_LIMITS.maxPrompts, idField: 'promptId' });
      const prompts = entries.map((entry) => Object.freeze({
        promptId: entry.promptId,
        ...(typeof entry.description === 'string' && entry.description.length <= 1024
          ? { description: SENSITIVE_USAGE_RE.test(entry.description) ? '[redacted]' : entry.description }
          : {}),
      }));
      noteSuccess();
      return Object.freeze({ provider: conf.providerId, prompts: Object.freeze(prompts) });
    },

    /** prompt.get — idempotent read of one prompt (bounded). */
    async promptGet({ authorization, promptId } = {}) {
      refuseDisabled('prompt.get');
      authorize(authorization, 'prompt.get', { requireGrant: false });
      if (typeof promptId !== 'string' || promptId.length === 0 || promptId.length > 64) {
        fail('lego.contract_violation', 'promptId must be a bounded identifier (1..64 chars)', { field: 'promptId' });
      }
      if (SENSITIVE_USAGE_RE.test(promptId)) {
        fail('lego.contract_violation', 'promptId carries a credential-shaped value', { field: 'promptId', reason: 'credential-shaped-value' });
      }
      const response = await exchangeOnce('prompt.get', {
        op: 'prompt.get',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        promptId,
      }, { operation: 'prompt.get', promptId });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — prompt.get must answer with an object', { operation: 'prompt.get' });
      }
      const content = assertContent(response.content, 'content', TOOL_PROVIDER_LIMITS.maxResultChars);
      noteSuccess();
      return Object.freeze({ provider: conf.providerId, promptId, content });
    },
  });

  return adapter;
}

/**
 * No-provider report (P2.25 §9 / manifest#zeroInstall): with no tool adapter
 * configured the answer is the canonical `not-configured` state — a valid AI
 * Foundation mode, never an error and never a fake tool success.
 */
export function describeProviderConfiguration(adapter = null) {
  if (adapter === null || adapter === undefined) {
    return Object.freeze({
      configuration: 'not-configured',
      state: 'not-configured',
      providerId: null,
      lastError: null,
      reportedAs: 'capability-unavailable',
      reason: 'no tool provider configured',
      valid: true,
    });
  }
  if (typeof adapter !== 'object' || typeof adapter.status !== 'function') {
    fail('lego.contract_violation', 'describeProviderConfiguration expects a tool provider adapter or null', { field: 'adapter' });
  }
  const status = adapter.status();
  return Object.freeze({
    configuration: 'configured',
    state: status.state,
    providerId: status.providerId,
    lastError: status.lastError,
    reportedAs: null,
    reason: null,
    valid: true,
  });
}
