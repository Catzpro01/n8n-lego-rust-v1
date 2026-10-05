/**
 * Model Provider Adapter — the first real model-provider adapter (P2.25).
 *
 * PUBLIC CONTRACT (`ai.model-gateway`, v1.0.0, owner: manager).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The adapter boundary that translates one explicitly configured external model
 * provider onto the canonical model gateway contract: `models.list`,
 * `model.describe`, `generate`, `stream`, `embed`, `countTokens` — quoted
 * byte-for-byte from `manifest/ai-foundation.json#modelGateway`. Consumers
 * depend on this contract; the provider implementation stays replaceable:
 *
 *   consumer → canonical contract → adapter → provider
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is not a vendor SDK, not a router, not an inference engine and not a
 * credential store. There is no default provider, no provider discovery, no
 * environment scanning and no implicit model selection: without an explicit
 * configuration this module only reports `not-configured`, which is a valid
 * supported state of the AI Foundation (manifest#zeroInstall), never an error
 * and never a fake completion.
 *
 * THE CREDENTIAL BOUNDARY (P2.25 §10)
 * ------------------------------------
 * Credentials are NEVER stored by LEGO. They are supplied per call by the
 * operator/application boundary — in practice: inside the injected `exchange`
 * binding, which this module never inspects, serializes, logs or echoes.
 * Configuration objects refuse credential-shaped fields and credential-shaped
 * string values at the door. Errors carry canonical codes and bounded metadata
 * only: no raw provider body, no prompt, no completion, no key, no header.
 *
 * AUTHORITY BOUNDARY (XA-8 / XA-10 consumed unchanged)
 * ----------------------------------------------------
 * A configured provider is an implementation source, never an authority grant.
 * Every call carries an explicit call-time authorization handoff naming the
 * published permission exactly (`ai:model:read` / `ai:model:invoke`). Invoke
 * operations additionally require the opaque `grantReference` under which the
 * caller's grant was presented upstream — verification of that grant belongs
 * to capability negotiation / approval contracts; this adapter fail-closes on
 * absence or mismatch and never grants, invents or reinterprets a permission
 * word (no duplicate vocabulary, `ai:*` namespace quoted from domains.json).
 *
 * HONEST USAGE (P2.24 preserved — §14/§15)
 * ----------------------------------------
 * Provider-reported figures report into `ai.token-usage@1.0.0` exactly as
 * reported — never turned into 0, never estimated without a canonical
 * estimator (none exists, so none is used), never fabricated. Missing usage is
 * `unavailable` with `value: null`. Stream usage finalizes ONCE at the final
 * provider usage envelope; in-chunk usage is ignored by construction, so
 * chunks + final aggregate can never double-count. `requestId` derivation is
 * idempotent: a retried call mints the same usage record identities, and the
 * token-usage foundation replays them without double-counting.
 *
 * DETERMINISM / DEPENDENCIES (§18/§19)
 * ------------------------------------
 * `now` and `newId` must be injected — no ambient clock, no ambient id, no
 * `node:*` import. All I/O is the injected `exchange` binding at the adapter
 * edge; the module itself performs no network call and adds no dependency.
 * The module performs at most ONE exchange per operation (`maxAttemptsPerCall: 1`
 * — there is no internal retry of any kind, §28).
 */

import { AI_FOUNDATION, AI_TRANSPORTS } from './ai-foundation.mjs';
import {
  SENSITIVE_USAGE_RE,
  TOKEN_KINDS,
  USAGE_LIMITS,
  USAGE_SCOPES,
  USAGE_STATUSES,
  USAGE_UNITS,
} from './token-usage.mjs';

/* ---------------------------------------------------------------- contract */

export const MODEL_GATEWAY_CONTRACT = Object.freeze({
  id: "ai.model-gateway",
  version: '1.0.0',
  owner: 'manager',
});

export const MODEL_GATEWAY_CONTRACT_VERSION = MODEL_GATEWAY_CONTRACT.version;

/** Operation names quoted from manifest#modelGateway — no synonym coined. */
export const MODEL_GATEWAY_OPERATIONS = Object.freeze(
  AI_FOUNDATION.modelGateway.operations.map((operation) => operation.name),
);

/** Permission words quoted from domains.json capability `ai.model-gateway`. */
export const MODEL_GATEWAY_PERMISSIONS = Object.freeze([
  'ai:model:invoke',
  'ai:model:read',
]);

/**
 * Provider configuration/status vocabulary (P2.25 §22): the six states the
 * frontend must distinguish without fabricating provider capability.
 * `not-configured` is the supported no-provider state of the AI Foundation;
 * provider state is never authority (`available` ≠ invoke authorized).
 */
export const PROVIDER_ADAPTER_STATES = Object.freeze([
  'not-configured',
  'configured',
  'available',
  'unavailable',
  'degraded',
  'disabled',
]);

/**
 * Exchange error kinds → canonical error codes. External provider error
 * shapes translate HERE; canonical categories stay stable across providers and
 * adapter-specific detail never becomes a second public error contract.
 */
export const PROVIDER_ERROR_TRANSLATION = Object.freeze({
  timeout: 'lego.deadline_exceeded',
  unavailable: 'lego.unavailable',
  'rate-limited': 'lego.backpressure',
  forbidden: 'lego.access_denied',
  cancelled: 'lego.cancelled',
});

/** Every canonical code this adapter may emit — all quoted from errors.contract.json 1.2.0. */
export const MODEL_PROVIDER_ERROR_CODES = Object.freeze([
  'lego.contract_violation',
  'lego.access_denied',
  'lego.unavailable',
  'lego.deadline_exceeded',
  'lego.operation_unsupported',
  'lego.dependency_disabled',
  'lego.backpressure',
  'lego.cancelled',
]);

/** Bounds — every exchange dimension is finite (P2.25 §27). */
export const MODEL_PROVIDER_LIMITS = Object.freeze({
  maxModels: 64,
  maxAttemptsPerCall: 1,
  maxInputChars: 262_144,
  maxOutputChars: 524_288,
  maxStreamChunks: 4096,
  maxStreamChars: 1_048_576,
  maxEmbedBatch: 256,
  maxEmbedDims: 8192,
  maxParameterKeys: 64,
  maxTimeoutMs: 600_000,
  maxRequestIdLength: 128,
  maxEndpointLength: 128,
  maxDetailLength: 128,
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

export class ModelProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelProviderError';
    if (!MODEL_PROVIDER_ERROR_CODES.includes(code)) {
      throw new Error(`unknown model-provider error code '${code}' — declare it in src/lego/contracts/errors.contract.json first`);
    }
    this.code = code;
    this.details = freezeDeep(sanitizeDetails(details));
  }
}

function fail(code, message, details = {}) {
  throw new ModelProviderError(code, message, details);
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
      const sliced = value.length > MODEL_PROVIDER_LIMITS.maxDetailLength
        ? value.slice(0, MODEL_PROVIDER_LIMITS.maxDetailLength)
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

function assertOpaqueReference(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('lego.contract_violation', `${field} is required`, { field });
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > MODEL_PROVIDER_LIMITS.maxEndpointLength
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
  if (typeof value !== 'string' || value.length === 0 && !allowEmpty || value.length > maxLength) {
    fail('lego.contract_violation', `${field} must be a string of ${allowEmpty ? '0..' : '1..'}${maxLength} characters`, {
      field,
      limit: maxLength,
    });
  }
  return value;
}

function assertTokenish(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > USAGE_LIMITS.maxTokenValue) {
    fail('lego.contract_violation', `${field} must be a non-negative safe integer token count`, {
      field,
      limit: 'maxTokenValue',
    });
  }
  return value;
}

/* -------------------------------------------------------- config validation */

function validateModelEntry(entry, providerId, index) {
  if (!isPlainObject(entry)) {
    fail('lego.contract_violation', `models[${index}] must be a plain object`, { field: `models[${index}]` });
  }
  const optionalKeys = new Set([
    'provider', 'contextSize', 'maxOutput', 'streaming', 'toolCalling', 'embedding',
    'modalities', 'costPerInputToken', 'costPerOutputToken', 'latencyProfile', 'region',
  ]);
  for (const key of Object.keys(entry)) {
    if (FORBIDDEN_CONFIG_FIELDS.includes(key)) {
      fail('lego.contract_violation', `'${key}' may never appear in a provider configuration — credentials are supplied per call and never stored`, {
        field: key,
        reason: 'credential-field-refused',
      });
    }
    if (!['modelId', 'availability'].includes(key) && !optionalKeys.has(key)) {
      fail('lego.contract_violation', `unknown model metadata field '${key}' — the declaration shape is the published modelMetadata vocabulary`, {
        field: key,
      });
    }
  }
  assertId(entry.modelId, `models[${index}].modelId`);
  if (!DECLARED_AVAILABILITIES.includes(entry.availability)) {
    fail('lego.contract_violation', `models[${index}].availability must be one of ${DECLARED_AVAILABILITIES.join(', ')}`, {
      field: `models[${index}].availability`,
    });
  }
  if (entry.provider !== undefined && entry.provider !== providerId) {
    fail('lego.contract_violation', `models[${index}].provider must equal the configuration providerId`, {
      field: `models[${index}].provider`,
    });
  }
  if (entry.contextSize !== undefined && (!Number.isSafeInteger(entry.contextSize) || entry.contextSize <= 0)) {
    fail('lego.contract_violation', 'contextSize must be a positive safe integer', { field: 'contextSize' });
  }
  if (entry.maxOutput !== undefined && (!Number.isSafeInteger(entry.maxOutput) || entry.maxOutput <= 0)) {
    fail('lego.contract_violation', 'maxOutput must be a positive safe integer', { field: 'maxOutput' });
  }
  for (const flag of ['streaming', 'toolCalling', 'embedding']) {
    if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
      fail('lego.contract_violation', `${flag} must be a boolean`, { field: flag });
    }
  }
  if (entry.modalities !== undefined) {
    if (!Array.isArray(entry.modalities) || entry.modalities.some((m) => typeof m !== 'string' || m.length === 0 || m.length > 64)) {
      fail('lego.contract_violation', 'modalities must be an array of bounded strings', { field: 'modalities' });
    }
  }
  for (const cost of ['costPerInputToken', 'costPerOutputToken']) {
    if (entry[cost] !== undefined) {
      // 0 is a KNOWN price (free), never a missing one — same rule as P2.24 cost.
      if (typeof entry[cost] !== 'number' || !Number.isFinite(entry[cost]) || entry[cost] < 0) {
        fail('lego.contract_violation', `${cost} must be a non-negative finite number — absent means unknown, never free`, { field: cost });
      }
    }
  }
  for (const text of ['latencyProfile', 'region']) {
    if (entry[text] !== undefined) {
      assertBoundedString(entry[text], text, 64);
      if (SENSITIVE_USAGE_RE.test(entry[text])) {
        fail('lego.contract_violation', `${text} carries a credential-shaped value`, { field: text, reason: 'credential-shaped-value' });
      }
    }
  }
  return entry;
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
    if (!['providerId', 'kind', 'availability', 'transport', 'endpoint', 'models'].includes(key)) {
      fail('lego.contract_violation', `unknown configuration field '${key}' — the model-provider config shape is closed`, { field: key });
    }
  }
  const required = AI_FOUNDATION.providerKinds['model-provider'].required;
  for (const field of required) {
    if (config[field] === undefined) {
      fail('lego.contract_violation', `config.${field} is required — provider configuration is explicit (no default provider, no auto-discovery)`, {
        field,
        required,
      });
    }
  }
  assertId(config.providerId, 'config.providerId');
  if (config.kind !== 'model-provider') {
    fail('lego.contract_violation', `unknown provider kind '${String(config.kind)}' — this adapter binds exactly 'model-provider' (fail-closed)`, {
      field: 'kind',
      expected: 'model-provider',
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
  if (!Array.isArray(config.models) || config.models.length > MODEL_PROVIDER_LIMITS.maxModels) {
    fail('lego.contract_violation', `config.models must be an array of at most ${MODEL_PROVIDER_LIMITS.maxModels} declared models`, {
      field: 'models',
      limit: 'maxModels',
    });
  }
  const seen = new Set();
  const models = config.models.map((entry, index) => {
    validateModelEntry(entry, config.providerId, index);
    if (seen.has(entry.modelId)) {
      fail('lego.contract_violation', `duplicate declared model '${entry.modelId}'`, { field: 'models' });
    }
    seen.add(entry.modelId);
    return Object.freeze({ ...entry, provider: config.providerId });
  });
  // Secret-scan every configuration string value (full-form detector, §20).
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
    models: Object.freeze(models),
  });
}

/* ------------------------------------------------------- usage (P2.24 §14) */

function readReportedFigure(rawValue, field) {
  if (rawValue === undefined || rawValue === null) {
    return Object.freeze({ status: 'unavailable', value: null });
  }
  if (!Number.isSafeInteger(rawValue) || rawValue < 0 || rawValue > USAGE_LIMITS.maxTokenValue) {
    // Present but malformed is a contract violation — never silently 'unavailable', never 0.
    fail('lego.contract_violation', `${field} must be a non-negative safe integer token count when present`, { field });
  }
  return Object.freeze({ status: 'reported', value: rawValue });
}

/**
 * Canonical usage envelope: per-figure certainty, never a fabricated aggregate.
 * `output` is always shaped; for embed calls no output figure is ever reported.
 */
function buildUsage(rawUsage) {
  const modelInput = readReportedFigure(rawUsage?.inputTokens, 'usage.inputTokens');
  const output = readReportedFigure(rawUsage?.outputTokens, 'usage.outputTokens');
  return Object.freeze({ modelInput, output });
}

function usageRecordId(requestId, suffix) {
  const derived = `${requestId}${suffix}`;
  if (!USAGE_ID_RE.test(derived)) {
    fail('lego.contract_violation', 'derived usage requestId must be a bounded identifier (1..128 chars) — supply a shorter requestId', {
      field: 'requestId',
      reason: 'usage-identity-overflow',
    });
  }
  return derived;
}

function reportUsage(recordUsage, { requestId, providerId, figures }) {
  if (typeof recordUsage !== 'function') return;
  for (const [suffix, kind, figure] of figures) {
    if (figure.status !== 'reported') continue; // unavailable is expressed by absence + response shape; never recorded as a number
    recordUsage(Object.freeze({
      requestId: usageRecordId(requestId, suffix),
      scopeLevel: USAGE_SCOPES[0], // 'call'
      scopeRef: requestId,
      kind,
      value: figure.value,
      unit: USAGE_UNITS[0], // 'tokens'
      status: USAGE_STATUSES[0], // 'reported'
      source: providerId,
      estimator: null,
    }));
  }
}

/* ---------------------------------------------------------- authorization */

function requiredPermission(operation) {
  const entry = AI_FOUNDATION.modelGateway.operations.find((op) => op.name === operation);
  /* c8 ignore next */
  if (!entry) fail('lego.operation_unsupported', `operation '${operation}' is not part of ai.model-gateway`, { operation });
  return entry.permission;
}

function authorize(authorization, operation, { requireGrant }) {
  const required = requiredPermission(operation);
  if (!isPlainObject(authorization)) {
    fail('lego.access_denied', 'call-time authorization handoff is required — a configured provider grants nothing by existing', {
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
      fail('lego.access_denied', 'invoke operations require an explicit grantReference — configuration is not authority', {
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
  if (error && typeof error.code === 'string' && MODEL_PROVIDER_ERROR_CODES.includes(error.code)) {
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

function transportFailure(operation, error, details) {
  const code = mapTransportError(error);
  // The provider's own message/body is NEVER echoed (§13) — only the canonical
  // category and bounded adapter-side metadata travel.
  fail(code, `provider exchange failed for '${operation}' (${code})`, { operation, ...details });
}

function canonicalModel(entry, overrides = {}) {
  const model = {
    modelId: entry.modelId,
    provider: entry.provider,
    availability: entry.availability,
  };
  for (const key of ['contextSize', 'maxOutput', 'streaming', 'toolCalling', 'embedding',
    'modalities', 'costPerInputToken', 'costPerOutputToken', 'latencyProfile', 'region']) {
    if (entry[key] !== undefined) model[key] = entry[key];
  }
  return Object.freeze({ ...model, ...overrides });
}

function normalizeProviderModels(response, declaredById) {
  if (!isPlainObject(response) || !Array.isArray(response.models)) {
    fail('lego.contract_violation', 'malformed provider response — models.list must answer with a models array', {
      operation: 'models.list',
      field: 'models',
    });
  }
  const out = [];
  for (const entry of response.models) {
    if (!isPlainObject(entry) || typeof entry.modelId !== 'string') {
      fail('lego.contract_violation', 'malformed provider response — each listed model needs a modelId', {
        operation: 'models.list',
        field: 'models[].modelId',
      });
    }
    const declared = declaredById.get(entry.modelId);
    if (!declared) continue; // never expose a model the configuration did not declare (explicit selection only)
    const availability = DECLARED_AVAILABILITIES.includes(entry.availability) ? entry.availability : declared.availability;
    out.push(canonicalModel(declared, { availability }));
  }
  return Object.freeze(out);
}

/* ---------------------------------------------------------------- adapter */

function validateInputText(input, field) {
  assertBoundedString(input, field, MODEL_PROVIDER_LIMITS.maxInputChars);
  if (input.length === 0) {
    fail('lego.contract_violation', `${field} must not be empty`, { field });
  }
  return input;
}

function validateParameters(parameters) {
  if (parameters === undefined || parameters === null) return null;
  if (!isPlainObject(parameters)) {
    fail('lego.contract_violation', 'parameters must be a plain object', { field: 'parameters' });
  }
  const keys = Object.keys(parameters);
  if (keys.length > MODEL_PROVIDER_LIMITS.maxParameterKeys) {
    fail('lego.contract_violation', `parameters are bounded at ${MODEL_PROVIDER_LIMITS.maxParameterKeys} keys`, {
      field: 'parameters',
      limit: 'maxParameterKeys',
    });
  }
  for (const key of keys) {
    const value = parameters[key];
    const scalars = ['string', 'number', 'boolean'];
    const valid = value === null
      || scalars.includes(typeof value)
      || (Array.isArray(value) && value.every((item) => item === null || scalars.includes(typeof item)));
    if (!valid) {
      fail('lego.contract_violation', `parameters.${key} must be a scalar or an array of scalars`, { field: `parameters.${key}` });
    }
    if (typeof value === 'string') {
      assertBoundedString(value, `parameters.${key}`, MODEL_PROVIDER_LIMITS.maxDetailLength, { allowEmpty: true });
      if (SENSITIVE_USAGE_RE.test(value)) {
        fail('lego.contract_violation', `parameters.${key} carries a credential-shaped value — parameters never smuggle credentials`, {
          field: `parameters.${key}`,
          reason: 'credential-shaped-value',
        });
      }
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      fail('lego.contract_violation', `parameters.${key} must be a finite number`, { field: `parameters.${key}` });
    }
  }
  return freezeDeep({ ...parameters });
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
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MODEL_PROVIDER_LIMITS.maxTimeoutMs) {
    fail('lego.contract_violation', `timeoutMs must be an integer in [1, ${MODEL_PROVIDER_LIMITS.maxTimeoutMs}]`, {
      field: 'timeoutMs',
      limit: 'maxTimeoutMs',
    });
  }
  return timeoutMs;
}

function validateRequestIdShape(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MODEL_PROVIDER_LIMITS.maxRequestIdLength || !USAGE_ID_RE.test(value)) {
    fail('lego.contract_violation', `requestId must be a bounded identifier (1..${MODEL_PROVIDER_LIMITS.maxRequestIdLength} chars)`, { field: 'requestId' });
  }
  if (SENSITIVE_USAGE_RE.test(value)) {
    fail('lego.contract_violation', 'requestId carries a credential-shaped value', { field: 'requestId', reason: 'credential-shaped-value' });
  }
  return value;
}

function validateRequestId(requestId, { required }) {
  if (requestId === undefined || requestId === null) {
    if (required) {
      fail('lego.contract_violation', 'requestId is required for invoke operations — provider-side idempotency needs an explicit identity', {
        field: 'requestId',
      });
    }
    return null;
  }
  return validateRequestIdShape(requestId);
}

/** Caller-supplied identity, or a `newId`-minted fallback — both shape-checked. */
function validateMintedRequestId(requestId, minted) {
  return requestId === undefined || requestId === null
    ? validateRequestIdShape(minted)
    : validateRequestIdShape(requestId);
}

export function createModelProviderAdapter({ config, exchange, recordUsage, now, newId } = {}) {
  if (typeof now !== 'function' || typeof newId !== 'function') {
    throw new ModelProviderError('lego.contract_violation', 'now and newId must be injected (no ambient clock, no ambient id)', {});
  }
  if (typeof exchange !== 'function') {
    fail('lego.contract_violation', 'exchange must be a function — the adapter edge is an injected binding, never a baked-in transport', {
      field: 'exchange',
    });
  }
  if (recordUsage !== undefined && typeof recordUsage !== 'function') {
    fail('lego.contract_violation', 'recordUsage must be a function when supplied', { field: 'recordUsage' });
  }
  const conf = validateConfig(config);
  // One clock read at creation (ISO fail-fast); status/metadata never touch an ambient clock.
  const configuredAtRaw = String(now());
  if (Number.isNaN(Date.parse(configuredAtRaw))) {
    fail('lego.contract_violation', 'now() must return an ISO timestamp', { field: 'now' });
  }
  const configuredAt = new Date(configuredAtRaw).toISOString();

  const declaredById = new Map(conf.models.map((model) => [model.modelId, model]));
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
      transportFailure(operation, error, { providerId: conf.providerId, ...details });
      /* c8 ignore next */
      return undefined;
    }
  }

  function requireDeclaredModel(modelId, operation) {
    const declared = declaredById.get(modelId);
    if (!declared) {
      fail('lego.operation_unsupported', `model '${modelId}' is not declared for this provider — unknown models fail closed, never auto-selected`, {
        operation,
        modelId,
        reason: 'model-not-declared',
      });
    }
    if (declared.availability === 'disabled') {
      fail('lego.operation_unsupported', `model '${modelId}' is declared disabled`, {
        operation,
        modelId,
        reason: 'model-disabled',
      });
    }
    return declared;
  }

  const adapter = Object.freeze({
    providerId: conf.providerId,
    contract: MODEL_GATEWAY_CONTRACT_VERSION,

    /**
     * Provider configuration/status (§22). `configuration` and `state` keep the
     * no-provider report usable by foundation-level callers: pass `null` to
     * `describeProviderConfiguration` instead of constructing an adapter.
     */
    status() {
      return Object.freeze({
        configuredAt,
        providerId: conf.providerId,
        configuration: 'configured',
        state,
        lastError,
        declaredAvailability: conf.availability,
        transport: conf.transport,
        endpoint: conf.endpoint,
        modelIds: Object.freeze(conf.models.map((model) => model.modelId)),
      });
    },

    /** models.list — idempotent read (one exchange, never retried internally). */
    async modelsList({ authorization } = {}) {
      refuseDisabled('models.list');
      authorize(authorization, 'models.list', { requireGrant: false });
      const response = await exchangeOnce('models.list', {
        op: 'models.list',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
      }, { operation: 'models.list' });
      const models = normalizeProviderModels(response, declaredById);
      noteSuccess();
      return Object.freeze({ provider: conf.providerId, models });
    },

    /** model.describe — canonical projection of one declared model. */
    async describe({ authorization, modelId } = {}) {
      refuseDisabled('model.describe');
      authorize(authorization, 'model.describe', { requireGrant: false });
      assertId(modelId, 'modelId');
      const declared = requireDeclaredModel(modelId, 'model.describe');
      const response = await exchangeOnce('model.describe', {
        op: 'model.describe',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        modelId,
      }, { operation: 'model.describe', modelId });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — model.describe must answer with an object', {
          operation: 'model.describe',
        });
      }
      if (response.modelId !== undefined && response.modelId !== modelId) {
        fail('lego.contract_violation', 'malformed provider response — describe answered for a different model', {
          operation: 'model.describe',
          field: 'modelId',
        });
      }
      noteSuccess();
      const availability = DECLARED_AVAILABILITIES.includes(response.availability)
        ? response.availability
        : declared.availability;
      return Object.freeze({
        model: canonicalModel(declared, { availability }),
        provider: conf.providerId,
      });
    },

    /**
     * generate — NON-idempotent invoke. Exactly one exchange; the adapter never
     * retries. Returns the canonical response shape {modelId, provider, output, usage}.
     */
    async generate({ authorization, modelId, input, parameters, timeoutMs, requestId } = {}) {
      refuseDisabled('generate');
      authorize(authorization, 'generate', { requireGrant: true });
      assertId(modelId, 'modelId');
      const declared = requireDeclaredModel(modelId, 'generate');
      const safeInput = validateInputText(input, 'input');
      const safeParameters = validateParameters(parameters);
      const safeTimeout = validateTimeout(timeoutMs, { required: true });
      const safeRequestId = validateMintedRequestId(requestId, `gen-${newId()}`);
      const response = await exchangeOnce('generate', {
        op: 'generate',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        modelId,
        input: safeInput,
        parameters: safeParameters,
        timeoutMs: safeTimeout,
        requestId: safeRequestId,
      }, { operation: 'generate', modelId });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — generate must answer with an object', { operation: 'generate' });
      }
      const output = assertBoundedString(response.output, 'output', MODEL_PROVIDER_LIMITS.maxOutputChars);
      const usage = buildUsage(response.usage);
      noteSuccess();
      reportUsage(recordUsage, {
        requestId: safeRequestId,
        providerId: conf.providerId,
        figures: [
          ['-modelInput', 'modelInput', usage.modelInput],
          ['-output', 'output', usage.output],
        ],
      });
      return Object.freeze({
        modelId,
        provider: conf.providerId,
        output,
        usage,
        requestId: safeRequestId,
      });
    },

    /**
     * stream — NON-idempotent invoke with the declared `block` backpressure
     * policy expressed as hard bounds (no drops, no unbounded accumulation).
     * Usage finalizes ONLY from the top-level (final) envelope; chunk-level
     * usage is ignored by construction — chunks + final can never double-count.
     */
    async stream({ authorization, modelId, input, parameters, timeoutMs, requestId } = {}) {
      refuseDisabled('stream');
      authorize(authorization, 'stream', { requireGrant: true });
      assertId(modelId, 'modelId');
      requireDeclaredModel(modelId, 'stream');
      const declared = declaredById.get(modelId);
      if (declared.streaming === false) {
        fail('lego.operation_unsupported', `model '${modelId}' declares streaming: false`, {
          operation: 'stream',
          modelId,
          reason: 'streaming-unsupported',
        });
      }
      const safeInput = validateInputText(input, 'input');
      const safeParameters = validateParameters(parameters);
      const safeTimeout = validateTimeout(timeoutMs, { required: true });
      const safeRequestId = validateMintedRequestId(requestId, `str-${newId()}`);
      const response = await exchangeOnce('stream', {
        op: 'stream',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        modelId,
        input: safeInput,
        parameters: safeParameters,
        timeoutMs: safeTimeout,
        requestId: safeRequestId,
      }, { operation: 'stream', modelId });
      if (!isPlainObject(response) || !Array.isArray(response.chunks)) {
        fail('lego.contract_violation', 'malformed provider response — stream must answer with a chunks array', { operation: 'stream' });
      }
      if (response.chunks.length > MODEL_PROVIDER_LIMITS.maxStreamChunks) {
        fail('lego.backpressure', `stream exceeded ${MODEL_PROVIDER_LIMITS.maxStreamChunks} chunks — the declared block policy bounds the buffer, it never accumulates unbounded`, {
          operation: 'stream',
          limit: 'maxStreamChunks',
        });
      }
      const chunks = [];
      let total = 0;
      for (const chunk of response.chunks) {
        if (typeof chunk !== 'string') {
          fail('lego.contract_violation', 'malformed provider response — stream chunks must be strings (chunk usage objects are not part of the dialect)', {
            operation: 'stream',
            field: 'chunks[]',
          });
        }
        total += chunk.length;
        if (total > MODEL_PROVIDER_LIMITS.maxStreamChars) {
          fail('lego.backpressure', `stream exceeded ${MODEL_PROVIDER_LIMITS.maxStreamChars} characters — block means bounded, never unbounded buffering`, {
            operation: 'stream',
            limit: 'maxStreamChars',
          });
        }
        chunks.push(chunk);
      }
      const usage = buildUsage(response.usage); // final envelope ONLY — chunk usage cannot appear in this dialect
      noteSuccess();
      reportUsage(recordUsage, {
        requestId: safeRequestId,
        providerId: conf.providerId,
        figures: [
          ['-modelInput', 'modelInput', usage.modelInput],
          ['-output', 'output', usage.output],
        ],
      });
      return Object.freeze({
        modelId,
        provider: conf.providerId,
        chunks: Object.freeze(chunks),
        output: chunks.join(''),
        usage,
        requestId: safeRequestId,
      });
    },

    /** embed — idempotent batch op; reported input tokens report as kind modelInput. */
    async embed({ authorization, modelId, input, timeoutMs, requestId } = {}) {
      refuseDisabled('embed');
      authorize(authorization, 'embed', { requireGrant: true });
      assertId(modelId, 'modelId');
      const declared = requireDeclaredModel(modelId, 'embed');
      if (declared.embedding === false) {
        fail('lego.operation_unsupported', `model '${modelId}' declares embedding: false`, {
          operation: 'embed',
          modelId,
          reason: 'embedding-unsupported',
        });
      }
      const texts = Array.isArray(input) ? input : [input];
      if (texts.length === 0 || texts.length > MODEL_PROVIDER_LIMITS.maxEmbedBatch) {
        fail('lego.contract_violation', `embed input must hold 1..${MODEL_PROVIDER_LIMITS.maxEmbedBatch} texts`, {
          field: 'input',
          limit: 'maxEmbedBatch',
        });
      }
      const safeTexts = texts.map((text, index) => validateInputText(text, `input[${index}]`));
      const safeTimeout = validateTimeout(timeoutMs, { required: true });
      const safeRequestId = validateMintedRequestId(requestId, `emb-${newId()}`);
      const response = await exchangeOnce('embed', {
        op: 'embed',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        modelId,
        input: safeTexts,
        timeoutMs: safeTimeout,
        requestId: safeRequestId,
      }, { operation: 'embed', modelId });
      if (!isPlainObject(response) || !Array.isArray(response.embeddings)) {
        fail('lego.contract_violation', 'malformed provider response — embed must answer with an embeddings array', { operation: 'embed' });
      }
      if (response.embeddings.length !== safeTexts.length) {
        fail('lego.contract_violation', 'malformed provider response — embeddings length must equal the input batch', {
          operation: 'embed',
          field: 'embeddings',
        });
      }
      const embeddings = response.embeddings.map((vector, index) => {
        if (!Array.isArray(vector) || vector.length === 0 || vector.length > MODEL_PROVIDER_LIMITS.maxEmbedDims) {
          fail('lego.contract_violation', `embeddings[${index}] must be an array of 1..${MODEL_PROVIDER_LIMITS.maxEmbedDims} numbers`, {
            field: `embeddings[${index}]`,
          });
        }
        for (const value of vector) {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            fail('lego.contract_violation', `embeddings[${index}] must contain finite numbers only`, { field: `embeddings[${index}]` });
          }
        }
        return Object.freeze([...vector]);
      });
      const usage = buildUsage(response.usage);
      noteSuccess();
      reportUsage(recordUsage, {
        requestId: safeRequestId,
        providerId: conf.providerId,
        figures: [
          ['-modelInput', 'modelInput', usage.modelInput],
          // embed has no output figure — nothing is invented to fill the shape
        ],
      });
      return Object.freeze({
        modelId,
        provider: conf.providerId,
        embeddings: Object.freeze(embeddings),
        usage: Object.freeze({
          modelInput: usage.modelInput,
          output: Object.freeze({ status: 'unavailable', value: null }),
        }),
        requestId: safeRequestId,
      });
    },

    /** countTokens — idempotent read; a measurement request, never a usage record. */
    async countTokens({ authorization, modelId, text } = {}) {
      refuseDisabled('countTokens');
      authorize(authorization, 'countTokens', { requireGrant: false });
      if (modelId !== undefined && modelId !== null) {
        assertId(modelId, 'modelId');
        requireDeclaredModel(modelId, 'countTokens');
      }
      const safeText = validateInputText(text, 'text');
      const response = await exchangeOnce('countTokens', {
        op: 'countTokens',
        providerId: conf.providerId,
        endpoint: conf.endpoint,
        transport: conf.transport,
        modelId: modelId ?? null,
        text: safeText,
      }, { operation: 'countTokens' });
      if (!isPlainObject(response)) {
        fail('lego.contract_violation', 'malformed provider response — countTokens must answer with an object', { operation: 'countTokens' });
      }
      const count = assertTokenish(response.count, 'count');
      noteSuccess();
      return Object.freeze({
        provider: conf.providerId,
        count,
      });
    },
  });

  return adapter;
}

/**
 * No-provider report (P2.25 §9 / manifest#zeroInstall): with no adapter
 * configured the answer is the canonical `not-configured` state — a valid,
 * fully supported AI Foundation mode, never an error, never a fake. With an
 * adapter it reports the live status. The reason string is quoted from
 * ai.foundation#zeroInstall.reportedAs.
 */
export function describeProviderConfiguration(adapter = null) {
  if (adapter === null || adapter === undefined) {
    return Object.freeze({
      configuration: 'not-configured',
      state: 'not-configured',
      providerId: null,
      lastError: null,
      reportedAs: 'capability-unavailable',
      reason: 'no inference provider configured',
      valid: true,
    });
  }
  if (typeof adapter !== 'object' || typeof adapter.status !== 'function') {
    fail('lego.contract_violation', 'describeProviderConfiguration expects a model provider adapter or null', { field: 'adapter' });
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
