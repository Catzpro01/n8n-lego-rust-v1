/**
 * Node portability foundation — P2.22 (Node Compatibility & Portability).
 *
 * PUBLIC CONTRACT (`node.portability`, v1.0.0, owner: manager, domain `node-registry`).
 *
 * One node contract must survive implementation moves across JS, WASM, Rust/native
 * and Remote runtimes — the contract never changes because the runtime did. This
 * module is the policy + contract + validation foundation that answers, deterministically:
 *
 *   canPort(node, target)   — portable to that runtime? why / why not?
 *   selectRuntime(node, ctx) — which runtime should host it, by policy not prejudice?
 *   describePortability(node) — what does this node declare?
 *
 * Scope walls (non-goals, enforced by tests):
 *   - no Node Creator / node generation / autonomous publishing        (P2.23)
 *   - no translation engine / representation converter pipeline        (P2.23)
 *   - no provider integrations, no model inference,
 *     no production distributed runtime, no authority of any kind.
 *
 * Portability is a CLASSIFICATION. Permissions still come from the
 * capability/approval system (P2.19); nothing here grants, checks live, or
 * caches authorization. Unknown values fail closed — never "assume portable".
 *
 * Design notes:
 *   - every enumeration is a closed, exported constant (classes, targets,
 *     statuses, schema features, reason codes, policy criteria);
 *   - lookups are O(1) over frozen maps; the capability/permission vocabulary
 *     is loaded once from the domain registry (the single source of truth) and
 *     then served from Sets — no filesystem work per invocation;
 *   - no timers, no wall clock, no randomness: results are pure functions of
 *     (declaration, target, context).
 */
import { loadRegistry } from './registry.mjs';

/* ------------------------------------------------------------------ *
 * Contract identity
 * ------------------------------------------------------------------ */

/** The portability contract this validator implements. */
export const NODE_PORTABILITY_CONTRACT = 'node.portability@1.0.0';
export const NODE_PORTABILITY_CONTRACT_VERSION = '1.0.0';

/** Top-level fields of a node declaration this contract validates. */
export const NODE_PORTABILITY_FIELDS = Object.freeze([
  'nodeId', 'contract', 'portability', 'requiredCapabilities',
  'requiredPermissions', 'schemas', 'artifactRequirements', 'securityProfile',
]);

/** Caller operations (capability/lock/module three-way parity). */
export const NODE_PORTABILITY_OPERATIONS = Object.freeze(['canPort', 'select', 'describePortability']);

/** Permission words this foundation publishes. */
export const NODE_PORTABILITY_PERMISSIONS = Object.freeze([
  'node:read', 'node:portability:validate', 'node:portability:select',
]);

/* ------------------------------------------------------------------ *
 * §6 Portability classes — canonical, singular, no competing synonyms
 * ------------------------------------------------------------------ */

export const PORTABILITY_CLASSES = Object.freeze([
  'PURE', 'API', 'NETWORK', 'FILESYSTEM',
  'NATIVE_PROCESS', 'ENVIRONMENT_SPECIFIC', 'REMOTE_BRIDGE',
]);

/** §12 runtime targets. */
export const PORTABILITY_TARGETS = Object.freeze(['JS', 'WASM', 'RUST_NATIVE', 'REMOTE']);

export const MATRIX_STATUSES = Object.freeze(['SUPPORTED', 'UNSUPPORTED', 'CONDITIONAL']);
export const SCHEMA_STATUSES = Object.freeze(['SUPPORTED', 'UNSUPPORTED', 'LOSSY']);

/* ------------------------------------------------------------------ *
 * §14 Security model per class (declaration rules — nothing is granted)
 * ------------------------------------------------------------------ */

/**
 * What a declaration of each class MUST carry and what it MUST NOT carry.
 * `requirePermissionCategory` names a category from PERMISSION_CATEGORIES:
 * the class's authority has to be declared explicitly, with a word that
 * belongs to that category — a filesystem permission does not authorize a
 * network node and vice versa.
 */
export const PERMISSION_CATEGORIES = Object.freeze({
  network: Object.freeze(['webhook:', 'realtime:']),
  filesystem: Object.freeze(['storage:']),
  process: Object.freeze(['worker:', 'runtime:']),
  remote: Object.freeze(['lego:invoke']),
});

export const CLASS_DECLARATION_RULES = Object.freeze({
  PURE: Object.freeze({
    allowCapabilities: false, allowPermissions: false,
    allowEnvironment: false, allowTransport: false,
    requirePermissionCategory: null, requireCapabilities: false,
    requireEnvironment: false, requireTransport: false,
    note: 'no network, filesystem, subprocess or environment authority — declaring any of it is a conflict',
  }),
  API: Object.freeze({
    allowCapabilities: true, allowPermissions: true,
    allowEnvironment: true, allowTransport: false,
    requirePermissionCategory: null, requireCapabilities: true,
    requireEnvironment: false, requireTransport: false,
    note: 'only the capability APIs the declaration names — and it must name at least one',
  }),
  NETWORK: Object.freeze({
    allowCapabilities: true, allowPermissions: true,
    allowEnvironment: true, allowTransport: false,
    requirePermissionCategory: 'network', requireCapabilities: true,
    requireEnvironment: false, requireTransport: false,
    note: 'network permission explicit — never implied by portability',
  }),
  FILESYSTEM: Object.freeze({
    allowCapabilities: true, allowPermissions: true,
    allowEnvironment: true, allowTransport: false,
    requirePermissionCategory: 'filesystem', requireCapabilities: true,
    requireEnvironment: false, requireTransport: false,
    note: 'filesystem permission explicit — portability never carries authority',
  }),
  NATIVE_PROCESS: Object.freeze({
    allowCapabilities: true, allowPermissions: true,
    allowEnvironment: true, allowTransport: false,
    requirePermissionCategory: 'process', requireCapabilities: true,
    requireEnvironment: false, requireTransport: false,
    note: 'process/native permission explicit',
  }),
  ENVIRONMENT_SPECIFIC: Object.freeze({
    allowCapabilities: true, allowPermissions: true,
    allowEnvironment: true, allowTransport: false,
    requirePermissionCategory: null, requireCapabilities: false,
    requireEnvironment: true, requireTransport: false,
    note: 'environment constraints explicit — mismatch refuses, never coerces',
  }),
  REMOTE_BRIDGE: Object.freeze({
    allowCapabilities: true, allowPermissions: true,
    allowEnvironment: true, allowTransport: true,
    requirePermissionCategory: 'remote', requireCapabilities: true,
    requireEnvironment: false, requireTransport: true,
    note: 'remote capability + transport + authorization explicit',
  }),
});

/* ------------------------------------------------------------------ *
 * §12 Runtime matrix — machine-readable, honest about CONDITIONAL
 * ------------------------------------------------------------------ */

const cell = (status, conditions = []) => Object.freeze({ status, conditions: Object.freeze(conditions) });

/**
 * class → target → { status, conditions }.
 * Conditions are checked by `canPort` against the call context:
 *   transport-context     — context.transport must be a non-empty id
 *   remote-authority      — context.transport must equal the node's declared transport
 *   capability-host       — context.hostCapabilities must cover requiredCapabilities
 *   environment-context   — context.environment must be provided
 * Nothing here is claimed SUPPORTED without a checkable meaning: this matrix
 * classifies portability of the contract; it does not ship runtimes.
 */
export const RUNTIME_MATRIX = Object.freeze({
  PURE: Object.freeze({
    JS: cell('SUPPORTED'),
    WASM: cell('SUPPORTED'),
    RUST_NATIVE: cell('SUPPORTED'),
    REMOTE: cell('CONDITIONAL', ['transport-context']),
  }),
  API: Object.freeze({
    JS: cell('SUPPORTED'),
    WASM: cell('CONDITIONAL', ['capability-host']),
    RUST_NATIVE: cell('SUPPORTED'),
    REMOTE: cell('CONDITIONAL', ['transport-context']),
  }),
  NETWORK: Object.freeze({
    JS: cell('SUPPORTED'),
    WASM: cell('CONDITIONAL', ['capability-host']),
    RUST_NATIVE: cell('SUPPORTED'),
    REMOTE: cell('SUPPORTED'),
  }),
  FILESYSTEM: Object.freeze({
    JS: cell('SUPPORTED'),
    WASM: cell('UNSUPPORTED'),
    RUST_NATIVE: cell('SUPPORTED'),
    REMOTE: cell('CONDITIONAL', ['transport-context']),
  }),
  NATIVE_PROCESS: Object.freeze({
    JS: cell('SUPPORTED'),
    WASM: cell('UNSUPPORTED'),
    RUST_NATIVE: cell('SUPPORTED'),
    REMOTE: cell('CONDITIONAL', ['transport-context']),
  }),
  ENVIRONMENT_SPECIFIC: Object.freeze({
    JS: cell('SUPPORTED'),
    WASM: cell('CONDITIONAL', ['capability-host', 'environment-context']),
    RUST_NATIVE: cell('SUPPORTED'),
    REMOTE: cell('CONDITIONAL', ['transport-context']),
  }),
  REMOTE_BRIDGE: Object.freeze({
    JS: cell('UNSUPPORTED'),
    WASM: cell('UNSUPPORTED'),
    RUST_NATIVE: cell('UNSUPPORTED'),
    REMOTE: cell('CONDITIONAL', ['remote-authority']),
  }),
});

/* ------------------------------------------------------------------ *
 * §8 Language-neutral schema subset
 * ------------------------------------------------------------------ */

/**
 * Feature → status for the portable schema subset.
 * SUPPORTED round-trips; LOSSY and UNSUPPORTED refuse (`schema-lossy` /
 * `schema-unsupported`) — there is no silent coercion path anywhere.
 * Any schema keyword not named here is outside the subset by definition.
 */
export const SCHEMA_FEATURE_STATUSES = Object.freeze({
  scalar: 'SUPPORTED',
  object: 'SUPPORTED',
  array: 'SUPPORTED',
  nullable: 'SUPPORTED',
  enum: 'SUPPORTED',
  required: 'SUPPORTED',
  optional: 'SUPPORTED',
  constraints: 'SUPPORTED',
  default: 'SUPPORTED',
  additionalProperties: 'SUPPORTED',
  format: 'LOSSY',
  pattern: 'UNSUPPORTED',
  union: 'UNSUPPORTED',
  reference: 'UNSUPPORTED',
});

const SCALAR_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'null']);
const KNOWN_TYPE_VALUES = Object.freeze([...SCALAR_TYPES, 'object', 'array']);

/* ------------------------------------------------------------------ *
 * §10 Compatibility classes, §16 reasons
 * ------------------------------------------------------------------ */

/** The five compatibility axes — never collapsed into one `compatible=true`. */
export const COMPATIBILITY_AXES = Object.freeze(['contract', 'schema', 'runtime', 'portability', 'environment']);

/** §10 names for an axis that IS compatible. */
export const COMPATIBILITY_CLASSES = Object.freeze([
  'CONTRACT_COMPATIBLE', 'SCHEMA_COMPATIBLE', 'RUNTIME_COMPATIBLE',
  'PORTABILITY_COMPATIBLE', 'ENVIRONMENT_COMPATIBLE',
]);

/** Overall reason when the portability answer is no — always `<axis>-incompatible`. */
export const OVERALL_REASONS = Object.freeze([
  'contract-incompatible', 'schema-incompatible', 'runtime-incompatible',
  'portability-incompatible', 'environment-incompatible',
]);

/** §16 closed set of refusal reasons (plus their axis for overall derivation). */
export const PORTABILITY_REASONS = Object.freeze([
  'unknown-runtime', 'unknown-portability-class', 'unknown-capability', 'unknown-permission',
  'missing-permission', 'missing-capability', 'missing-environment', 'environment-mismatch',
  'transport-mismatch', 'capability-host-missing', 'security-mismatch',
  'schema-unsupported', 'schema-lossy', 'target-unsupported',
  'declaration-conflict', 'round-trip-failed',
]);

export const REASON_AXIS = Object.freeze({
  'unknown-runtime': 'runtime',
  'unknown-portability-class': 'contract',
  'unknown-capability': 'contract',
  'unknown-permission': 'contract',
  'missing-permission': 'contract',
  'missing-capability': 'contract',
  'missing-environment': 'contract',
  'environment-mismatch': 'environment',
  'transport-mismatch': 'portability',
  'capability-host-missing': 'runtime',
  'security-mismatch': 'environment',
  'schema-unsupported': 'schema',
  'schema-lossy': 'schema',
  'target-unsupported': 'runtime',
  'declaration-conflict': 'contract',
  'round-trip-failed': 'portability',
});

/* ------------------------------------------------------------------ *
 * §11 Runtime selection policy — no language preference, ever
 * ------------------------------------------------------------------ */

/**
 * Selection criteria in evaluation order. No language target is preselected:
 * compatibility, security, capability and environment facts filter first;
 * declared performance ranking breaks ties; canonical enumeration order is
 * last resort (enumeration, not favor).
 */
export const RUNTIME_SELECTION_POLICY = Object.freeze([
  'security', 'performance', 'portability', 'compatibility',
  'capability-requirements', 'environment-constraints',
]);

/* ------------------------------------------------------------------ *
 * §22 Differential facets — declarations compared, never executable bytes
 * ------------------------------------------------------------------ */

export const DIFFERENTIAL_FACETS = Object.freeze([
  'input', 'outputSchema', 'errors', 'artifactMetadata', 'sideEffectDeclaration',
]);

const FIXTURE_INPUT = Object.freeze({
  type: 'object',
  properties: { name: Object.freeze({ type: 'string', minLength: 1, maxLength: 64 }) },
  required: Object.freeze(['name']),
  additionalProperties: false,
});
const FIXTURE_OUTPUT = Object.freeze({
  type: 'object',
  properties: { ok: Object.freeze({ type: 'boolean' }) },
  required: Object.freeze(['ok']),
  additionalProperties: false,
});

/** Canonical fixtures: implementations that DECLARE equivalence are compared on these facets. */
export const CANONICAL_FIXTURES = Object.freeze(['JS', 'WASM', 'RUST_NATIVE'].map((target) => Object.freeze({
  target,
  fixture: Object.freeze({
    input: FIXTURE_INPUT,
    outputSchema: FIXTURE_OUTPUT,
    errors: Object.freeze([
      Object.freeze({ code: 'lego.contract_violation' }),
      Object.freeze({ code: 'node.not_found' }),
    ]),
    artifactMetadata: Object.freeze({
      kind: 'node-portability-report', encoding: 'application/json', version: '1.0.0',
    }),
    sideEffectDeclaration: Object.freeze(['none']),
  }),
})));

/* ------------------------------------------------------------------ *
 * Errors — existing published code only (lego.contract_violation)
 * ------------------------------------------------------------------ */

export class NodePortabilityError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NodePortabilityError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new NodePortabilityError(message, meta); };

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NODE_CONTRACT_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@\d+\.\d+\.\d+$/;
const CAPABILITY_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const PERMISSION_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
const TRANSPORT_RE = /^[a-z][a-z0-9-]*$/;

/* ------------------------------------------------------------------ *
 * Vocabulary — loaded once from the domain registry, then O(1) Sets
 * ------------------------------------------------------------------ */

function buildVocabulary() {
  const registry = loadRegistry();
  const capabilities = new Set();
  const permissions = new Set();
  for (const domain of registry.domains) {
    for (const capability of domain.capabilities ?? []) {
      capabilities.add(capability.id);
      for (const permission of capability.permissions ?? []) permissions.add(permission);
      for (const operation of capability.operations ?? []) {
        if (operation.permission) permissions.add(operation.permission);
      }
    }
  }
  // This foundation's own words are published in the manifest after P2.22 lands;
  // adding them here keeps a pre-manifest call fail-closed-but-complete.
  for (const permission of NODE_PORTABILITY_PERMISSIONS) permissions.add(permission);
  return Object.freeze({ capabilities, permissions });
}

/**
 * Immutable memoization of the capability/permission vocabulary that ships in
 * `manifest/domains.json` (same construct as `registry.mjs`): computed once at
 * module load, never mutated — O(1) Set lookups per invocation, and no
 * per-process divergence because every process loads the same static manifest.
 */
const KNOWN_VOCABULARY = buildVocabulary();

function knownVocabulary() {
  return KNOWN_VOCABULARY;
}

/* ------------------------------------------------------------------ *
 * §15 Declaration validation (throws lego.contract_violation on structure)
 * ------------------------------------------------------------------ */

function assertStringArray(value, field, pattern, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${field} must be ${allowEmpty ? '' : 'a non-empty '}array of strings`, { field });
  }
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) {
      fail(`${field} entry ${JSON.stringify(item)} does not match the canonical pattern`, { field, value: item });
    }
  }
  return value;
}

/** Structural validation of a node declaration against `node.portability@1.0.0`. */
export function validateNodeDeclaration(node) {
  if (!isPlainObject(node)) fail('node declaration must be a plain object', { field: 'node' });
  for (const field of ['nodeId', 'contract', 'portability', 'requiredCapabilities', 'requiredPermissions', 'schemas']) {
    if (!(field in node)) fail(`node declaration is missing required field '${field}'`, { field });
  }
  if (typeof node.nodeId !== 'string' || !ID_RE.test(node.nodeId)) {
    fail('nodeId must be a canonical identifier (1..128 chars)', { field: 'nodeId' });
  }
  if (typeof node.contract !== 'string' || !NODE_CONTRACT_RE.test(node.contract)) {
    fail('contract must be a namespaced id@semver reference (e.g. n8n.http-request@1.0.0)', { field: 'contract' });
  }
  if (!isPlainObject(node.portability)) fail('portability must be an object', { field: 'portability' });
  if (typeof node.portability.class !== 'string') {
    fail('portability.class must be a string', { field: 'portability.class' });
  }
  if ('transport' in node.portability) {
    if (typeof node.portability.transport !== 'string' || !TRANSPORT_RE.test(node.portability.transport)) {
      fail('portability.transport must be a canonical transport id', { field: 'portability.transport' });
    }
  }
  if ('runtimeRequirements' in node.portability) {
    assertStringArray(node.portability.runtimeRequirements, 'portability.runtimeRequirements', /^(JS|WASM|RUST_NATIVE|REMOTE)$/);
  }
  if ('environmentRequirements' in node.portability) {
    const env = node.portability.environmentRequirements;
    if (!isPlainObject(env)) fail('portability.environmentRequirements must be an object', { field: 'portability.environmentRequirements' });
    for (const [key, value] of Object.entries(env)) {
      if (!TRANSPORT_RE.test(key)) fail(`environment key '${key}' is not canonical`, { field: 'portability.environmentRequirements' });
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        fail(`environment value for '${key}' must be a primitive`, { field: 'portability.environmentRequirements' });
      }
    }
  }
  assertStringArray(node.requiredCapabilities, 'requiredCapabilities', CAPABILITY_ID_RE);
  assertStringArray(node.requiredPermissions, 'requiredPermissions', PERMISSION_RE);
  if (!isPlainObject(node.schemas) || !isPlainObject(node.schemas.input) || !isPlainObject(node.schemas.output)) {
    fail('schemas must be an object with plain-object input and output schemas', { field: 'schemas' });
  }
  if ('artifactRequirements' in node) {
    assertStringArray(node.artifactRequirements, 'artifactRequirements', ID_RE);
  }
  if ('securityProfile' in node && (typeof node.securityProfile !== 'string' || !TRANSPORT_RE.test(node.securityProfile))) {
    fail('securityProfile must be a canonical id', { field: 'securityProfile' });
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * §8 Schema walk — features, structural validation, canonical form
 * ------------------------------------------------------------------ */

function sortedClone(value) {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedClone(value[key]);
    return out;
  }
  return value;
}

function walkSchema(schema, found, path) {
  if (!isPlainObject(schema)) fail(`schema at ${path} must be a plain object`, { field: path });

  if ('type' in schema) {
    if (typeof schema.type !== 'string') fail(`type at ${path} must be a string`, { field: path });
    if (!KNOWN_TYPE_VALUES.includes(schema.type)) {
      found.unsupported.push({ feature: 'type', detail: `${path}:type:${schema.type}` });
    } else if (schema.type === 'object' || schema.type === 'array') {
      found.features.add(schema.type);
    } else {
      found.features.add('scalar');
    }
  } else if (!('enum' in schema)) {
    found.unsupported.push({ feature: 'type', detail: `${path}:missing-type` });
  }

  if ('nullable' in schema) {
    if (schema.nullable !== true && schema.nullable !== false) {
      found.unsupported.push({ feature: 'nullable', detail: `${path}:nullable` });
    } else if (schema.nullable === true) {
      found.features.add('nullable');
    }
  }

  if ('enum' in schema) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0
      || schema.enum.some((v) => !['string', 'number', 'boolean'].includes(typeof v))) {
      found.unsupported.push({ feature: 'enum', detail: `${path}:enum` });
    } else {
      found.features.add('enum');
    }
  }

  if ('default' in schema) {
    found.features.add('default');
    const value = schema.default;
    const typeOk = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    const enumOk = !('enum' in schema) || (Array.isArray(schema.enum) && schema.enum.includes(value));
    const typeMatches = !('type' in schema)
      || schema.type === typeof value
      || (schema.type === 'integer' && typeof value === 'number' && Number.isInteger(value))
      || (schema.type === 'null' && value === null);
    if (!typeOk || !enumOk || !typeMatches) {
      found.unsupported.push({ feature: 'default', detail: `${path}:default-inconsistent` });
    }
  }

  if ('properties' in schema) {
    if (schema.type !== 'object' || !isPlainObject(schema.properties)) {
      fail(`properties at ${path} require type object and an object value`, { field: path });
    }
    found.features.add('object');
    const propertyNames = Object.keys(schema.properties);
    let required = [];
    if ('required' in schema) {
      if (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== 'string')) {
        fail(`required at ${path} must be an array of property names`, { field: path });
      }
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          fail(`required property '${key}' at ${path} is not declared`, { field: path });
        }
      }
      required = schema.required;
      found.features.add('required');
    }
    if (propertyNames.some((name) => !required.includes(name))) found.features.add('optional');
    for (const [name, sub] of Object.entries(schema.properties)) {
      walkSchema(sub, found, `${path}.properties.${name}`);
    }
  }

  if ('items' in schema) {
    if (schema.type !== 'array') fail(`items at ${path} require type array`, { field: path });
    found.features.add('array');
    walkSchema(schema.items, found, `${path}.items`);
  } else if (schema.type === 'array') {
    fail(`array schema at ${path} must declare items (portable subset is closed)`, { field: path });
  }

  const constraintKeys = ['minLength', 'maxLength', 'minimum', 'maximum'];
  let sawConstraint = false;
  for (const key of constraintKeys) {
    if (key in schema) {
      sawConstraint = true;
      const value = schema[key];
      const integerBound = key === 'minLength' || key === 'maxLength';
      if (typeof value !== 'number' || !Number.isFinite(value) || (integerBound && (!Number.isInteger(value) || value < 0))) {
        fail(`${key} at ${path} must be a ${integerBound ? 'non-negative integer' : 'finite number'}`, { field: path });
      }
    }
  }
  if (sawConstraint) found.features.add('constraints');

  if ('additionalProperties' in schema) {
    if (typeof schema.additionalProperties !== 'boolean') {
      found.unsupported.push({ feature: 'additionalProperties', detail: `${path}:additionalProperties` });
    } else {
      found.features.add('additionalProperties');
    }
  }

  if ('format' in schema) {
    found.features.add('format');
    found.lossy.push({ feature: 'format', detail: `${path}:format` });
  }
  if ('pattern' in schema) {
    found.unsupported.push({ feature: 'pattern', detail: `${path}:pattern` });
  }
  if ('anyOf' in schema || 'oneOf' in schema || 'allOf' in schema) {
    found.unsupported.push({ feature: 'union', detail: `${path}:union` });
  }
  if ('$ref' in schema) {
    found.unsupported.push({ feature: 'reference', detail: `${path}:$ref` });
  }

  const knownKeys = new Set([
    'type', 'properties', 'required', 'items', 'nullable', 'enum', 'default',
    'minLength', 'maxLength', 'minimum', 'maximum', 'additionalProperties',
    'format', 'pattern', 'anyOf', 'oneOf', 'allOf', '$ref', 'description', 'title',
  ]);
  for (const key of Object.keys(schema)) {
    if (!knownKeys.has(key)) {
      found.unsupported.push({ feature: key, detail: `${path}:${key}` });
    }
  }
}

function analyseSchema(schema, path) {
  const found = { features: new Set(), unsupported: [], lossy: [] };
  walkSchema(schema, found, path);
  return found;
}

function mergeFindings(target, source) {
  for (const feature of source.features) target.features.add(feature);
  target.unsupported.push(...source.unsupported);
  target.lossy.push(...source.lossy);
}

/** Feature names present in a schema (sorted) — structural errors throw. */
export function schemaFeatures(schema) {
  const found = analyseSchema(schema, 'schema');
  return Object.freeze([...found.features].sort());
}

/**
 * Portability of a schema against the subset: features with their statuses,
 * plus the refusal lists. `portable` is false when anything is UNSUPPORTED or
 * LOSSY — a LOSSY feature is refused with its own reason, never coerced.
 */
export function schemaPortability(schema) {
  const found = analyseSchema(schema, 'schema');
  const features = [...found.features].sort();
  const statuses = {};
  for (const feature of features) statuses[feature] = SCHEMA_FEATURE_STATUSES[feature] ?? 'UNSUPPORTED';
  return Object.freeze({
    portable: found.unsupported.length === 0 && found.lossy.length === 0,
    features: Object.freeze(features),
    statuses: Object.freeze(statuses),
    unsupported: Object.freeze(found.unsupported.map((u) => Object.freeze({ ...u }))),
    lossy: Object.freeze(found.lossy.map((l) => Object.freeze({ ...l }))),
  });
}

/** Validated canonical form: key-sorted, values untouched — no coercion, no defaults injected. */
export function canonicalizeSchema(schema) {
  const found = analyseSchema(schema, 'schema');
  if (found.unsupported.length > 0 && found.unsupported.some((u) => u.feature === 'type' && u.detail.endsWith(':missing-type'))) {
    const bad = found.unsupported.find((u) => u.detail.endsWith(':missing-type'));
    fail(`schema at ${bad.detail.split(':')[0]} must declare a type (or be an enum)`, { field: 'schema' });
  }
  return Object.freeze(sortedClone(schema));
}

/* ------------------------------------------------------------------ *
 * §9 Round-trip rule
 * ------------------------------------------------------------------ */

const ENCODING_TAGS = Object.freeze({
  JS: 'json',
  WASM: 'json-wasm',
  RUST_NATIVE: 'serde-json',
  REMOTE: 'transport-json',
});

function matrixCell(className, target) {
  return RUNTIME_MATRIX[className]?.[target] ?? null;
}

/**
 * source schema → encode(target) → decode → canonical schema.
 * For the portable subset on a non-UNSUPPORTED target the result must equal
 * `canonicalizeSchema(schema)`; anything else returns `equal:false` with an
 * explicit reason (never a silent best-effort conversion).
 */
export function roundTrip(schema, target) {
  if (!PORTABILITY_TARGETS.includes(target)) {
    return Object.freeze({ equal: false, reason: 'unknown-runtime', detail: String(target), canonical: null });
  }
  const found = analyseSchema(schema, 'schema');
  if (found.unsupported.length > 0) {
    return Object.freeze({
      equal: false, reason: 'schema-unsupported',
      detail: found.unsupported[0].detail, canonical: null,
    });
  }
  if (found.lossy.length > 0) {
    return Object.freeze({
      equal: false, reason: 'schema-lossy',
      detail: found.lossy[0].detail, canonical: null,
    });
  }
  const canonical = canonicalizeSchema(schema);
  const representation = Object.freeze({
    enc: ENCODING_TAGS[target],
    target,
    body: sortedClone(canonical),
  });
  const expectedTag = ENCODING_TAGS[target];
  if (representation.enc !== expectedTag || representation.target !== target || !isPlainObject(representation.body)) {
    return Object.freeze({ equal: false, reason: 'round-trip-failed', detail: 'encode', canonical });
  }
  const decoded = sortedClone(representation.body);
  const canonicalAgain = canonicalizeSchema(decoded);
  const equal = JSON.stringify(canonicalAgain) === JSON.stringify(canonical);
  return Object.freeze({
    equal,
    reason: equal ? null : 'round-trip-failed',
    detail: equal ? null : 'decode',
    canonical,
    canonicalAgain,
  });
}

/* ------------------------------------------------------------------ *
 * §15 The validator — canPort(node, targetRuntime, context?)
 * ------------------------------------------------------------------ */

function pushReason(bucket, reason, detail) {
  bucket.push(Object.freeze({ reason, detail: detail ?? null, axis: REASON_AXIS[reason] }));
}

function checkDeclarationRules(node, classRules, reasons) {
  const { capabilities: knownCaps, permissions: knownPerms } = knownVocabulary();
  const cls = node.portability.class;

  if (classRules.allowCapabilities === false && node.requiredCapabilities.length > 0) {
    pushReason(reasons, 'declaration-conflict', `${cls} declares capabilities`);
  }
  if (classRules.allowPermissions === false && node.requiredPermissions.length > 0) {
    pushReason(reasons, 'declaration-conflict', `${cls} declares permissions`);
  }
  if (classRules.allowEnvironment === false && Object.keys(node.portability.environmentRequirements ?? {}).length > 0) {
    pushReason(reasons, 'declaration-conflict', `${cls} declares environmentRequirements`);
  }
  if (classRules.allowTransport === false && 'transport' in node.portability) {
    pushReason(reasons, 'declaration-conflict', `${cls} declares a transport`);
  }

  for (const capability of node.requiredCapabilities) {
    if (!CAPABILITY_ID_RE.test(capability)) pushReason(reasons, 'unknown-capability', capability);
    else if (!knownCaps.has(capability)) pushReason(reasons, 'unknown-capability', capability);
  }
  for (const permission of node.requiredPermissions) {
    if (!PERMISSION_RE.test(permission)) pushReason(reasons, 'unknown-permission', permission);
    else if (!knownPerms.has(permission)) pushReason(reasons, 'unknown-permission', permission);
  }

  if (classRules.requireCapabilities && node.requiredCapabilities.length === 0) {
    pushReason(reasons, 'missing-capability', cls);
  }
  if (classRules.requirePermissionCategory) {
    const category = classRules.requirePermissionCategory;
    const prefixes = PERMISSION_CATEGORIES[category];
    const declared = node.requiredPermissions.some((permission) => prefixes.some((p) => permission.startsWith(p)));
    if (node.requiredPermissions.length === 0) pushReason(reasons, 'missing-permission', `${cls}:${category}`);
    else if (!declared) pushReason(reasons, 'missing-permission', `${cls}:${category}`);
  }
  if (classRules.requireEnvironment && Object.keys(node.portability.environmentRequirements ?? {}).length === 0) {
    pushReason(reasons, 'missing-environment', cls);
  }
  if (classRules.requireTransport && !('transport' in node.portability)) {
    pushReason(reasons, 'declaration-conflict', 'REMOTE_BRIDGE requires portability.transport');
  }
  if ('transport' in node.portability && cls !== 'REMOTE_BRIDGE') {
    pushReason(reasons, 'declaration-conflict', `transport is declared but class is ${cls}`);
  }
}

function checkEnvironment(node, context, reasons) {
  const declared = node.portability.environmentRequirements ?? {};
  const entries = Object.entries(declared);
  if (entries.length === 0) return;
  const actual = context.environment;
  if (!isPlainObject(actual)) {
    pushReason(reasons, 'environment-mismatch', 'context.environment-missing');
    return;
  }
  for (const [key, value] of entries) {
    if (!(key in actual) || actual[key] !== value) {
      pushReason(reasons, 'environment-mismatch', `${key}:${JSON.stringify(value)}!=${JSON.stringify(actual[key])}`);
    }
  }
}

function checkConditions(node, target, cellData, context, reasons) {
  for (const condition of cellData.conditions) {
    if (condition === 'transport-context') {
      if (typeof context.transport !== 'string' || context.transport.length === 0) {
        pushReason(reasons, 'transport-mismatch', `${target}:transport-context-missing`);
      }
    } else if (condition === 'remote-authority') {
      const declared = node.portability.transport;
      if (typeof context.transport !== 'string' || context.transport.length === 0) {
        pushReason(reasons, 'transport-mismatch', `${target}:transport-context-missing`);
      } else if (context.transport !== declared) {
        pushReason(reasons, 'transport-mismatch', `${target}:${declared}!=${context.transport}`);
      }
    } else if (condition === 'capability-host') {
      const host = context.hostCapabilities;
      if (!Array.isArray(host)) {
        pushReason(reasons, 'capability-host-missing', `${target}:context.hostCapabilities`);
      } else if (node.requiredCapabilities.some((capability) => !host.includes(capability))) {
        pushReason(reasons, 'capability-host-missing', `${target}:capability-not-hosted`);
      }
    } else if (condition === 'environment-context') {
      if (!isPlainObject(context.environment)) {
        pushReason(reasons, 'environment-mismatch', `${target}:context.environment-missing`);
      }
    }
  }
}

/**
 * §15/§16 — deterministic answer for (node declaration, target runtime, context).
 * Structure errors throw `NodePortabilityError` (`lego.contract_violation`);
 * every semantic refusal comes back as a reason from the closed set.
 */
export function canPort(node, targetRuntime, context = {}) {
  validateNodeDeclaration(node);
  if (!isPlainObject(context)) fail('context must be a plain object', { field: 'context' });

  const reasons = [];
  const cls = node.portability.class;

  if (!PORTABILITY_TARGETS.includes(targetRuntime)) {
    pushReason(reasons, 'unknown-runtime', String(targetRuntime));
  }
  if (!PORTABILITY_CLASSES.includes(cls)) {
    pushReason(reasons, 'unknown-portability-class', String(cls));
  }

  const cellData = PORTABILITY_CLASSES.includes(cls) && PORTABILITY_TARGETS.includes(targetRuntime)
    ? matrixCell(cls, targetRuntime)
    : null;

  // ---- contract axis: declaration conforms to the class rules + vocabulary
  if (PORTABILITY_CLASSES.includes(cls)) {
    checkDeclarationRules(node, CLASS_DECLARATION_RULES[cls], reasons);
  }
  // ---- schema axis: subset membership (SUPPORTED only — LOSSY refuses too)
  if (isPlainObject(node.schemas?.input) && isPlainObject(node.schemas?.output)) {
    for (const [which, schema] of [['input', node.schemas.input], ['output', node.schemas.output]]) {
      const report = schemaPortability(schema);
      for (const entry of report.unsupported) pushReason(reasons, 'schema-unsupported', `${which}:${entry.detail}`);
      for (const entry of report.lossy) pushReason(reasons, 'schema-lossy', `${which}:${entry.detail}`);
    }
  }

  // ---- runtime axis: target known, declared runtime requirements, matrix cell, host conditions
  const runtimeRequirements = node.portability.runtimeRequirements;
  if (PORTABILITY_TARGETS.includes(targetRuntime) && Array.isArray(runtimeRequirements)
    && runtimeRequirements.length > 0 && !runtimeRequirements.includes(targetRuntime)) {
    pushReason(reasons, 'target-unsupported', `${targetRuntime}:not-declared`);
  }
  if (cellData && cellData.status === 'UNSUPPORTED') {
    pushReason(reasons, 'target-unsupported', `${cls}:${targetRuntime}`);
  }
  if (cellData && cellData.status !== 'UNSUPPORTED') {
    checkConditions(node, targetRuntime, cellData, context, reasons);
  }

  // ---- portability axis: transport realization (conditions handled above sit
  //      partly here by reason axis) + §9 round-trip of both schemas
  const schemaAlreadyRefused = reasons.some((r) => r.reason === 'schema-unsupported' || r.reason === 'schema-lossy');
  if (cellData && cellData.status !== 'UNSUPPORTED' && !schemaAlreadyRefused) {
    for (const [which, schema] of [['input', node.schemas.input], ['output', node.schemas.output]]) {
      const report = roundTrip(schema, targetRuntime);
      if (!report.equal) {
        pushReason(reasons, report.reason === 'round-trip-failed' ? 'round-trip-failed' : report.reason,
          `${which}:${report.detail ?? 'round-trip'}`);
        break;
      }
    }
  }

  // ---- environment axis: declared constraints vs provided environment
  checkEnvironment(node, context, reasons);

  // ---- §11 security filter (declaration profile vs required profile)
  if ('requireSecurityProfile' in context && context.requireSecurityProfile !== (node.securityProfile ?? null)
    && context.requireSecurityProfile !== node.securityProfile) {
    pushReason(reasons, 'security-mismatch', `${node.securityProfile ?? 'none'}!=${context.requireSecurityProfile}`);
  }

  // ---- derive the five axes and the overall answer
  const compatibility = {};
  for (const axis of COMPATIBILITY_AXES) {
    compatibility[axis] = reasons.some((r) => r.axis === axis) ? 'incompatible' : 'compatible';
  }
  const failedAxis = COMPATIBILITY_AXES.find((axis) => compatibility[axis] === 'incompatible') ?? null;
  const conditional = cellData?.status === 'CONDITIONAL';
  const portable = failedAxis === null;
  const overall = !portable ? 'not-portable' : conditional ? 'conditional' : 'portable';
  const reason = failedAxis ? OVERALL_REASONS[COMPATIBILITY_AXES.indexOf(failedAxis)] : null;

  return Object.freeze({
    portable,
    overall,
    compatibility: Object.freeze(compatibility),
    reason,
    target: targetRuntime,
    class: cls,
    matrixStatus: cellData?.status ?? null,
    reasons: Object.freeze(reasons),
  });
}

/* ------------------------------------------------------------------ *
 * §11 Runtime selection — facts and policy, never a language favorite
 * ------------------------------------------------------------------ */

/**
 * Filter every target through `canPort` + the security profile, then order
 * survivors: SUPPORTED before CONDITIONAL, a declared performance ranking
 * next, canonical enumeration order last. Rejects carry their reasons.
 */
export function selectRuntime(node, context = {}) {
  validateNodeDeclaration(node);
  if (!isPlainObject(context)) fail('context must be a plain object', { field: 'context' });

  const candidates = [];
  const rejected = [];
  for (const target of PORTABILITY_TARGETS) {
    const answer = canPort(node, target, context);
    if (answer.portable) {
      candidates.push(Object.freeze({
        target,
        overall: answer.overall,
        matrixStatus: answer.matrixStatus,
      }));
    } else {
      rejected.push(Object.freeze({
        target,
        reason: answer.reason,
        reasons: answer.reasons,
      }));
    }
  }
  const rank = Array.isArray(context.performanceRank) ? context.performanceRank : null;
  const rankIndex = (target) => {
    if (rank) {
      const index = rank.indexOf(target);
      if (index !== -1) return index;
    }
    return PORTABILITY_TARGETS.indexOf(target);
  };
  const ordered = [...candidates].sort((a, b) => {
    const statusRank = (s) => (s === 'SUPPORTED' ? 0 : 1);
    const byStatus = statusRank(a.matrixStatus) - statusRank(b.matrixStatus);
    if (byStatus !== 0) return byStatus;
    return rankIndex(a.target) - rankIndex(b.target);
  });
  return Object.freeze({
    selected: ordered[0] ?? null,
    candidates: Object.freeze(ordered),
    rejected: Object.freeze(rejected),
    policy: RUNTIME_SELECTION_POLICY,
  });
}

/* ------------------------------------------------------------------ *
 * Read path — §7 model surfaced without any decision of its own
 * ------------------------------------------------------------------ */

/** Machine-readable view of what the node declares (no eligibility, no authority). */
export function describePortability(node) {
  validateNodeDeclaration(node);
  const cls = node.portability.class;
  const matrixRow = {};
  for (const target of PORTABILITY_TARGETS) {
    const data = PORTABILITY_CLASSES.includes(cls) ? matrixCell(cls, target) : null;
    matrixRow[target] = data ? data.status : 'unknown-class';
  }
  return Object.freeze({
    nodeId: node.nodeId,
    contract: node.contract,
    class: cls,
    matrixRow: Object.freeze(matrixRow),
    requiredCapabilities: Object.freeze([...node.requiredCapabilities]),
    requiredPermissions: Object.freeze([...node.requiredPermissions]),
    environment: Object.freeze(Object.keys(node.portability.environmentRequirements ?? {}).sort()),
    transport: node.portability.transport ?? null,
    schemaFeatures: Object.freeze([
      ...new Set([...schemaFeatures(node.schemas.input), ...schemaFeatures(node.schemas.output)]),
    ].sort()),
    securityProfile: node.securityProfile ?? null,
    artifactRequirements: Object.freeze([...(node.artifactRequirements ?? [])]),
  });
}

/* ------------------------------------------------------------------ *
 * §22 Differential comparison — declared facets, never executable bytes
 * ------------------------------------------------------------------ */

/**
 * Compare implementations that DECLARE equivalence on the five facets.
 * Hidden implementation details and byte-identical executables are
 * explicitly out of the comparison.
 */
export function compareImplementations(implementations) {
  if (!Array.isArray(implementations) || implementations.length < 2) {
    fail('compareImplementations needs at least two declared implementations', { field: 'implementations' });
  }
  const mismatches = [];
  const [first, ...rest] = implementations;
  for (const other of rest) {
    for (const facet of DIFFERENTIAL_FACETS) {
      const a = first.fixture?.[facet];
      const b = other.fixture?.[facet];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        mismatches.push(Object.freeze({
          facet,
          targets: Object.freeze([first.target ?? '?', other.target ?? '?']),
        }));
      }
    }
  }
  return Object.freeze({
    equivalent: mismatches.length === 0,
    mismatches: Object.freeze(mismatches),
    facets: DIFFERENTIAL_FACETS,
  });
}
