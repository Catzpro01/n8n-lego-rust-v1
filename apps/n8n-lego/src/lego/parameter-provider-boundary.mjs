/**
 * P7-S07 — Plugin/Provider Runtime Boundary (#223 §17, §19, §22, §32-33, §35-36, §42 P7.7).
 *
 * The boundary slice: it fixes WHAT a provider/plugin may declare and carry across the P7
 * boundary, and what P7 will NOT become. P7 owns parameter resolution; P6 owns node/runtime
 * admission and trust; P8 owns storage; P9 owns observability. This module enforces the seams:
 *
 *  - §17/§33 provider registration: a provider may live inside a node/plugin, but registration
 *    must DECLARE identity, version, capability requirements, locality, runtime trust class, and
 *    resource budgets. The descriptor is normalized to the canonical shape — vendor-specific
 *    business-model fields are EXCLUDED from the public contract (P7 does not import vendor
 *    models into public parameter contracts).
 *  - §22  provider-backed schema: a base schema + a bounded provider fragment (versioned,
 *    size-bounded, validated, capability-scoped, cacheable, replaceable). A provider CANNOT
 *    replace the canonical P7 contract or security model.
 *  - §32  community node compatibility: existing node definitions work without mandatory rewrite
 *    — accept the canonical n8n declaration, compile, preserve supported fields, reject only
 *    truly invalid/unsafe forms, expose diagnostics, fallback only where required.
 *  - §35  storage boundary: only bounded derived/cache state belongs in P7 (P7 does not become P8).
 *  - §36  observability: a CLOSED set of bounded P9 events; never secret material or full
 *    sensitive parameter payloads.
 *
 * Deterministic and testable; no provider is implemented here (admission, storage, and the
 * observability backend are P6/P8/P9). It reuses the same-domain `scrub` (P7-S06) and
 * `canonicalJson` (P7-S01) — no second subsystem.
 */
import { canonicalJson } from './parameter-plan.mjs';
import { scrub } from './parameter-credential.mjs';

export const PROVIDER_BOUNDARY_FORMAT = 'n8n-lego.provider-boundary';
export const PROVIDER_BOUNDARY_FORMAT_VERSION = 1;

/** §17/§33 — the closed runtime trust classes a provider may declare (admission is P6's). */
export const PROVIDER_TRUST_CLASSES = Object.freeze({
  LOCAL: 'local',
  NODE: 'node',
  APPLICATION: 'application',
  REMOTE: 'remote',
});

/** §17/§33 — the fields a provider registration MUST declare. */
export const PROVIDER_REQUIRED_FIELDS = Object.freeze(['id', 'version', 'capabilities', 'locality', 'trustClass', 'budgets']);

/** §22/§32/§35/§36 — the boundary budgets. */
export const PROVIDER_LIMITS = Object.freeze({
  maxIdLength: 128,
  maxCapabilities: 32,
  maxFragmentBytes: 32 * 1024,
  maxDiagnostics: 128,
  maxDerivedStateBytes: 1024 * 1024,
  maxEventsPerSink: 4096,
});

/** The closed failure vocabulary for the boundary. */
export const BOUNDARY_FAILURE_CODES = Object.freeze([
  'PROVIDER_DECLARATION_INVALID', 'PROVIDER_CONTRACT_INVALID',
  'SCHEMA_FRAGMENT_INVALID', 'SCHEMA_FRAGMENT_SECURITY_OVERRIDE',
  'NODE_DECLARATION_INVALID', 'STORAGE_BOUNDARY_VIOLATION',
  'EVENT_INVALID', 'SCHEMA_INVALID',
]);

export class ProviderBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProviderBoundaryError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ §17/§33 provider registration */

/**
 * §17/§33 — register a parameter provider. The declaration MUST declare identity, version,
 * capability requirements, locality, runtime trust class, and resource budgets. The result is a
 * normalized, immutable canonical descriptor: ONLY the canonical fields are carried — any
 * vendor-specific business-model fields are EXCLUDED from the public contract. The trust class is
 * declared and validated (it must be one of PROVIDER_TRUST_CLASSES); ADMISSION is P6's, not P7's.
 */
export function registerProvider(declaration, limits = PROVIDER_LIMITS) {
  if (!isPlainObject(declaration)) {
    throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', 'a provider declaration must be an object');
  }
  for (const field of PROVIDER_REQUIRED_FIELDS) {
    if (!(field in declaration) || declaration[field] === undefined || declaration[field] === null) {
      throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', `provider declaration is missing required field "${field}"`, { field });
    }
  }
  const id = declaration.id;
  if (typeof id !== 'string' || id === '' || id.length > limits.maxIdLength) {
    throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', `provider id must be a non-empty string <= ${limits.maxIdLength} chars`);
  }
  if (typeof declaration.version !== 'string' || declaration.version === '') {
    throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', 'provider version must be a non-empty string');
  }
  const capabilities = declaration.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > limits.maxCapabilities) {
    throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', `provider capabilities must be a non-empty array (<= ${limits.maxCapabilities})`);
  }
  for (const c of capabilities) {
    if (typeof c !== 'string' || c === '') {
      throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', 'each capability must be a non-empty string');
    }
  }
  if (typeof declaration.locality !== 'string' || declaration.locality === '') {
    throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', 'provider locality must be a non-empty string');
  }
  if (!(declaration.trustClass in PROVIDER_TRUST_CLASSES) && !Object.values(PROVIDER_TRUST_CLASSES).includes(declaration.trustClass)) {
    throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', `provider trustClass must be one of ${Object.values(PROVIDER_TRUST_CLASSES).join(', ')}`, { trustClass: declaration.trustClass });
  }
  const budgets = declaration.budgets;
  if (!isPlainObject(budgets) || Object.keys(budgets).length === 0) {
    throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', 'provider budgets must be a non-empty object of numeric bounds');
  }
  for (const [k, v] of Object.entries(budgets)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new ProviderBoundaryError('PROVIDER_DECLARATION_INVALID', `provider budget "${k}" must be a non-negative finite number`);
    }
  }
  // §17 — normalize to the canonical descriptor; vendor-specific fields are EXCLUDED.
  return Object.freeze({
    kind: 'ProviderDescriptor',
    id,
    version: declaration.version,
    capabilities: Object.freeze([...capabilities].sort()),
    locality: declaration.locality,
    trustClass: declaration.trustClass,
    budgets: Object.freeze(Object.fromEntries(Object.entries(budgets).sort(([a], [b]) => a.localeCompare(b)))),
  });
}

/* ------------------------------------------------------------------ §22 provider-backed schema */

/** §22 — fields a provider fragment must NOT override (the canonical contract / security model). */
const SECURITY_OVERRIDE_FIELDS = Object.freeze(['security', 'authorization', 'auth', 'credentials', 'canonical', 'permission', 'policy']);

/**
 * §22 — validate a provider schema fragment against a base schema. The fragment must be
 * versioned, size-bounded, validated, capability-scoped, cacheable, and replaceable. A provider
 * CANNOT replace the canonical P7 contract or security model: a fragment that carries a
 * security/canonical override field is rejected (SCHEMA_FRAGMENT_SECURITY_OVERRIDE). The base
 * schema is always authoritative.
 */
export function validateProviderSchemaFragment(baseSchema, fragment, limits = PROVIDER_LIMITS) {
  if (!isPlainObject(baseSchema) || !isPlainObject(baseSchema.schema)) {
    throw new ProviderBoundaryError('SCHEMA_FRAGMENT_INVALID', 'a base schema with a .schema object is required');
  }
  if (!isPlainObject(fragment)) {
    throw new ProviderBoundaryError('SCHEMA_FRAGMENT_INVALID', 'a provider schema fragment must be an object');
  }
  // A provider cannot replace the canonical contract or security model.
  for (const field of SECURITY_OVERRIDE_FIELDS) {
    if (field in fragment) {
      throw new ProviderBoundaryError('SCHEMA_FRAGMENT_SECURITY_OVERRIDE', `a provider fragment cannot override the canonical/security field "${field}"`, { field });
    }
  }
  if (typeof fragment.version !== 'string' || fragment.version === '') {
    throw new ProviderBoundaryError('SCHEMA_FRAGMENT_INVALID', 'a provider fragment must be versioned (a non-empty string version)');
  }
  const size = canonicalJson(fragment).length;
  if (size > limits.maxFragmentBytes) {
    throw new ProviderBoundaryError('SCHEMA_FRAGMENT_INVALID', `a provider fragment exceeds ${limits.maxFragmentBytes} bytes`, { size, limit: limits.maxFragmentBytes });
  }
  if (!isPlainObject(fragment.schema) || Object.keys(fragment.schema).length === 0) {
    throw new ProviderBoundaryError('SCHEMA_FRAGMENT_INVALID', 'a provider fragment must carry a non-empty .schema object');
  }
  if (typeof fragment.capability !== 'string' || fragment.capability === '') {
    throw new ProviderBoundaryError('SCHEMA_FRAGMENT_INVALID', 'a provider fragment must be capability-scoped (a non-empty string capability)');
  }
  if (fragment.cacheable !== true) {
    throw new ProviderBoundaryError('SCHEMA_FRAGMENT_INVALID', 'a provider fragment must be cacheable (cacheable: true)');
  }
  // §22 — the fragment is replaceable: it is a plain object (never the base schema itself).
  return Object.freeze({
    kind: 'ProviderSchemaFragment',
    version: fragment.version,
    capability: fragment.capability,
    cacheable: true,
    schema: Object.freeze(JSON.parse(JSON.stringify(fragment.schema))),
    baseAuthoritative: true,
  });
}

/* ------------------------------------------------------------------ §32 community node compatibility */

/** §32 — the supported canonical n8n node fields (preserved without rewrite). */
export const SUPPORTED_NODE_FIELDS = Object.freeze(['name', 'type', 'typeVersion', 'version', 'position', 'inputs', 'outputs', 'parameters', 'credentials', 'disabled', 'notes']);

/**
 * §32 — compile a community node declaration. Accepts a canonical n8n declaration, compiles it,
 * preserves supported upstream fields, rejects ONLY truly invalid/unsafe forms, exposes
 * compatibility diagnostics (unsupported fields are warnings, not rejections), and uses a
 * fallback only where upstream semantics require it. P7 is a compatibility layer, not a new
 * node-authoring language.
 *
 * Returns a frozen { ok, plan, diagnostics, fallbacks }.
 */
export function compileCommunityNodeDeclaration(declaration, limits = PROVIDER_LIMITS) {
  const diagnostics = [];
  const fallbacks = [];
  if (!isPlainObject(declaration)) {
    throw new ProviderBoundaryError('NODE_DECLARATION_INVALID', 'a node declaration must be an object');
  }
  if (typeof declaration.name !== 'string' || declaration.name.trim() === '') {
    throw new ProviderBoundaryError('NODE_DECLARATION_INVALID', 'a node declaration requires a non-empty string name');
  }
  // Preserve supported upstream fields; diagnose unsupported ones (not a rejection).
  const plan = { name: declaration.name.trim() };
  for (const [key, value] of Object.entries(declaration)) {
    if (key === 'name') continue;
    if (SUPPORTED_NODE_FIELDS.includes(key)) {
      plan[key] = value;
    } else {
      if (diagnostics.length < limits.maxDiagnostics) {
        diagnostics.push(Object.freeze({ level: 'warning', code: 'UNSUPPORTED_FIELD', field: key, message: `field "${key}" is not a supported n8n node field; preserved as opaque metadata` }));
      }
      (plan._metadata ??= {})[key] = value;
    }
  }
  // Fallback only where upstream semantics require it.
  if (!('type' in plan)) {
    plan.type = plan.name;
    fallbacks.push(Object.freeze({ field: 'type', reason: 'upstream nodes without an explicit type default to the node name' }));
  }
  if (!('parameters' in plan) || plan.parameters === undefined) {
    plan.parameters = {};
    fallbacks.push(Object.freeze({ field: 'parameters', reason: 'a node without declared parameters falls back to an empty parameter set' }));
  }
  if (!('typeVersion' in plan) && !('version' in plan)) {
    plan.typeVersion = 1;
    fallbacks.push(Object.freeze({ field: 'typeVersion', reason: 'a node without a declared version falls back to version 1' }));
  }
  return Object.freeze({ ok: true, plan, diagnostics: Object.freeze(diagnostics), fallbacks: Object.freeze(fallbacks) });
}

/* ------------------------------------------------------------------ §35 storage boundary */

/** §35 — markers of canonical workflow / durable state that must NOT live in P7 (P8 owns them). */
const CANONICAL_STATE_MARKERS = Object.freeze(['workflows', 'connections', 'durable', 'persistent', 'executionLog']);

/**
 * §35 — P7 does not become P8. Only bounded derived/cache state (normalized options, plans,
 * snapshots, digests) belongs in P7. This rejects canonical workflow definitions, durable
 * records, and unbounded state (STORAGE_BOUNDARY_VIOLATION) and accepts bounded derived state
 * within the size limit.
 */
export function assertBoundedDerivedState(state, limits = PROVIDER_LIMITS) {
  if (state === undefined || state === null || (typeof state !== 'object')) {
    throw new ProviderBoundaryError('STORAGE_BOUNDARY_VIOLATION', 'derived state must be an object (bounded derived/cache state only)');
  }
  for (const marker of CANONICAL_STATE_MARKERS) {
    if (marker in state) {
      throw new ProviderBoundaryError('STORAGE_BOUNDARY_VIOLATION', `canonical/durable state ("${marker}") does not belong in P7 — that is P8`, { marker });
    }
  }
  const size = canonicalJson(state).length;
  if (size > limits.maxDerivedStateBytes) {
    throw new ProviderBoundaryError('STORAGE_BOUNDARY_VIOLATION', `derived state exceeds ${limits.maxDerivedStateBytes} bytes (unbounded state is not P7)`, { size, limit: limits.maxDerivedStateBytes });
  }
  return Object.freeze({ allowed: true, bytes: size });
}

/* ------------------------------------------------------------------ §36 bounded observability */

/** §36 — the CLOSED set of P9 events P7 may emit. */
export const OBSERVABILITY_EVENTS = Object.freeze({
  RESOLVE_STARTED: 'parameter.resolve.started',
  RESOLVE_COMPLETED: 'parameter.resolve.completed',
  RESOLVE_FAILED: 'parameter.resolve.failed',
  CACHE_HIT: 'parameter.cache.hit',
  CACHE_MISS: 'parameter.cache.miss',
  PROVIDER_TIMEOUT: 'parameter.provider.timeout',
  PROVIDER_RATE_LIMITED: 'parameter.provider.rate_limited',
  VALIDATION_FAILED: 'parameter.validation.failed',
  STALE_RESPONSE_DISCARDED: 'parameter.stale_response.discarded',
});

const EVENT_NAMES = Object.freeze(Object.values(OBSERVABILITY_EVENTS));

/**
 * §36 — a bounded observability sink. Emits only the CLOSED P9 event set; rejects unknown events
 * (EVENT_INVALID); is bounded (max events retained); and scrubs any secret material from payloads
 * (never emit secret material or full sensitive parameter payloads).
 */
export function createObservabilitySink(secrets = [], limits = PROVIDER_LIMITS, now = Date.now) {
  const events = [];
  return {
    emit(name, payload = {}) {
      if (!EVENT_NAMES.includes(name)) {
        throw new ProviderBoundaryError('EVENT_INVALID', `unknown P9 event "${name}"`, { allowed: EVENT_NAMES });
      }
      if (payload !== null && typeof payload !== 'object') {
        throw new ProviderBoundaryError('EVENT_INVALID', 'an event payload must be an object');
      }
      const scrubbed = scrub(payload ?? {}, secrets);
      const event = Object.freeze({ name, at: now(), payload: scrubbed });
      if (events.length < limits.maxEventsPerSink) events.push(event);
      return event;
    },
    events() { return [...events]; },
    size() { return events.length; },
    clear() { events.length = 0; },
  };
}
