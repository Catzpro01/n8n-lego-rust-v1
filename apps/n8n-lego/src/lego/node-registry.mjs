/**
 * Node registry foundation — P6.1 (Canonical Node Registry Contract).
 *
 * PUBLIC CONTRACT (`node.registry@0.1.0`, domain `node-registry`).
 *
 * P6 owns the node registry. `manifest/node-contract.json` fixes what a node IS
 * — "this is a DEFINITION, not a Node Registry implementation — P6 implements
 * the registry, this fixes the shape it must honour" — and this module is the
 * first P6 milestone: the canonical node identity, the metadata a declaration
 * must carry, and a deterministic, fail-closed schema for both.
 *
 * The central promise is unchanged from the foundation and is restated here
 * because P6 is where it starts being enforced mechanically:
 *
 *   a node's identity never changes because its implementation changed.
 *
 * Identity is `type` + `typeVersion`. Language, runtime, package origin, vendor
 * and trust class are all metadata ABOUT a node — never part of what a workflow
 * refers to, and never a reason to trust it.
 *
 * WHAT THIS IS NOT (P6.1 scope walls, enforced by tests):
 *   - not the registry compiler, an epoch or an immutable snapshot   (P6.2)
 *   - no package mutation, no install journal, no single-flight      (P6.3)
 *   - no dependency closure, no content-addressed store              (P6.4)
 *   - no workflow resolution manifest, no runtime lease              (P6.5/P6.6)
 *   - no admission decision, no quarantine, no supply-chain proof    (P6.11-P6.29)
 *   - no filesystem, no network, no timers, no wall clock, no randomness:
 *     results are pure functions of the declarations handed in.
 *
 * Authority: nothing here grants, checks or caches trust, capability or
 * permission. A declaration is a claim about a node; admission is a later
 * milestone's decision. Every unknown value fails closed — unknown trust,
 * unknown capability, unknown runtime, unknown lifecycle, unknown heritage and
 * unknown fields all refuse instead of being assumed.
 *
 * Vocabulary is QUOTED, never reinvented. Two published sources, both named:
 *   `manifest/foundation.json` (published surface of `lego-foundation`) —
 *     trust classes, capabilities, runtimes, failure boundaries, resource
 *     classes. Read as data, the same file `lego-foundation` itself reads; the
 *     accessor module (`src/lego/foundation.mjs`) is deliberately NOT imported,
 *     because it is outside that domain's published surface (gate rule R4).
 *   `lego.negotiation` (published) — lifecycle states.
 *   `node.portability` (same domain) — portability targets.
 *   the pinned n8n catalog — discovery groups (`INodeTypeBaseDescription.group`).
 *
 * Compatibility observation (measured, not assumed). `node.contract` describes
 * `typeVersion` as an integer; the pinned `n8n-nodes-base@2.9.1` catalog carries
 * fractional versions (1.1 … 4.4), and 90 of its 483 node types declare several
 * versions at once (`n8n-nodes-base.httpRequest`: 3, 4, 4.1, 4.2, 4.3, 4.4). A
 * node identity therefore accepts a positive number with at most one decimal
 * place, and the pinned catalog stays the behavioural reference for which
 * versions exist.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIFECYCLE_STATES } from './negotiation.mjs';
import { PORTABILITY_TARGETS } from './node-portability.mjs';

/* ------------------------------------------------------------------ *
 * Quoted vocabulary source
 * ------------------------------------------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The published foundation manifest — the contract-first source of truth this
 * module quotes. Read once at load: it ships with the package, never changes
 * under a running process, and is nobody's mutable state.
 */
export const NODE_REGISTRY_VOCABULARY_SOURCE = 'src/lego/manifest/foundation.json';

const FOUNDATION_MANIFEST = Object.freeze(JSON.parse(readFileSync(resolve(HERE, 'manifest', 'foundation.json'), 'utf8')));

/* ------------------------------------------------------------------ *
 * Contract identity
 * ------------------------------------------------------------------ */

/** The registry contract this module implements. */
export const NODE_REGISTRY_CONTRACT = 'node.registry@0.1.0';
export const NODE_REGISTRY_CONTRACT_VERSION = '0.1.0';

/**
 * Schema revision of the declaration shape below. Bumping it is a contract
 * decision: the shape is closed, so a new field is a versioned change, never a
 * silent extension.
 */
export const NODE_REGISTRY_SCHEMA_VERSION = 1;

/** Caller operations this contract publishes. */
export const NODE_REGISTRY_OPERATIONS = Object.freeze(['validate', 'canonicalize', 'index']);

/** Permission words this contract consumes. P6.1 adds none of its own. */
export const NODE_REGISTRY_PERMISSIONS = Object.freeze(['node:read']);

/**
 * Every field a canonical registry declaration carries, in canonical order.
 * `NODE_REGISTRY_FIELDS` is the schema; anything outside it is refused.
 */
export const NODE_REGISTRY_FIELDS = Object.freeze([
  'type',
  'typeVersion',
  'package',
  'packageVersion',
  'vendor',
  'contractVersion',
  'implementationVersion',
  'digest',
  'provenance',
  'capabilities',
  'trustClass',
  'runtimeLocality',
  'resourceProfile',
  'compatibility',
  'lifecycle',
  'health',
  'discovery',
]);

/** Fields without which a declaration is not a node declaration at all. */
export const NODE_REGISTRY_REQUIRED_FIELDS = Object.freeze([...NODE_REGISTRY_FIELDS]);

/** Optional fields: absent is meaningful, present must still be valid. */
export const NODE_REGISTRY_OPTIONAL_FIELDS = Object.freeze(['notes']);

/* ------------------------------------------------------------------ *
 * Identity — type + typeVersion, and nothing else
 * ------------------------------------------------------------------ */

/**
 * A node type id: `package.nodeName`, optionally scoped (`@scope/package.node`).
 * The pinned catalog uses `n8n-nodes-base.httpRequest`; scoped ids such as
 * `@n8n/n8n-nodes-langchain.agent` are valid in the wider ecosystem.
 */
export const NODE_TYPE_ID_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\.[A-Za-z][A-Za-z0-9_]*$/;

/** A node version: positive number, at most one decimal place (1, 2, 4.4). */
export const NODE_TYPE_VERSION_RE = /^[1-9][0-9]*(?:\.[0-9])?$/;

/** A canonical identity: `<type>@<typeVersion>`. */
export const NODE_IDENTITY_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\.[A-Za-z][A-Za-z0-9_]*@[1-9][0-9]*(?:\.[0-9])?$/;

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const RANGE_RE = /^(?:\^|~|>=|>|<=|=)?\d+\.\d+\.\d+$|^\*$/;

/** n8n node groups (`INodeTypeBaseDescription.group`), quoted from the catalog. */
export const NODE_DISCOVERY_GROUPS = Object.freeze([
  'input', 'output', 'organization', 'schedule', 'transform', 'trigger',
]);

/** Health vocabulary. `degraded`/`disabled` are shared with the lifecycle words. */
export const NODE_HEALTH_STATES = Object.freeze([
  'unknown', 'healthy', 'degraded', 'failing', 'quarantined',
]);

/**
 * How a declaration came to exist. `attested-build` demands a reference to the
 * attestation (P6.12 owns the verification); the other kinds claim nothing.
 */
export const NODE_PROVENANCE_KINDS = Object.freeze([
  'local-source', 'package-registry', 'artifact-mirror', 'attested-build',
]);

/** Concurrency vocabulary, quoted from `manifest/node-contract.json`. */
export const NODE_CONCURRENCY_MODES = Object.freeze(['parallel-safe', 'queueable', 'exclusive']);

/** Compatibility verdict vocabulary, quoted from `lego.contract-compat`. */
export const NODE_COMPATIBILITY_KINDS = Object.freeze([
  'unchanged', 'compatible', 'migration-required', 'breaking', 'downgrade',
]);

/** Quoted enumerations. Nothing below is re-declared here. */
export const NODE_TRUST_CLASSES = Object.freeze(Object.keys(FOUNDATION_MANIFEST.trust.levels));
export const NODE_CAPABILITIES = Object.freeze([...FOUNDATION_MANIFEST.trust.capabilities]);
export const NODE_LIFECYCLE_STATES = Object.freeze(Object.keys(LIFECYCLE_STATES));
export const NODE_FAILURE_BOUNDARIES = Object.freeze([...FOUNDATION_MANIFEST.failureBoundaries.levels]);
export const NODE_RESOURCE_FIELDS = Object.freeze([...FOUNDATION_MANIFEST.resources.fields]);
export const NODE_RESOURCE_CLASSES = Object.freeze(
  Object.fromEntries(Object.entries(FOUNDATION_MANIFEST.resources.classes).map(([key, values]) => [key, Object.freeze([...values])])),
);

/**
 * Hosting runtimes, quoted from `foundation.json` `runtimes`.
 *
 * That object also carries the prose key `selectionRule`, which is a rule, not
 * a runtime — so the listing is taken from the runtime descriptors themselves
 * (entries that describe themselves) rather than from the key list, and it is
 * sorted, so the vocabulary has exactly one canonical order regardless of JSON
 * key order.
 */
export const NODE_RUNTIME_LOCALITIES = Object.freeze(
  Object.entries(FOUNDATION_MANIFEST.runtimes)
    .filter(([, descriptor]) => typeof descriptor === 'object' && descriptor !== null)
    .map(([runtime]) => runtime)
    .sort(),
);

/**
 * The canonical locality model: the conceptual placement (master prompt §11)
 * mapped onto the runtimes, failure boundaries and portability targets this
 * repository already publishes. A mapping — not a second vocabulary.
 */
export const RUNTIME_LOCALITY_MODEL = Object.freeze([
  {
    locality: 'IN_PROCESS',
    runtime: 'js-compat',
    failureBoundary: 'in-process-safe',
    portabilityTargets: ['JS'],
    policy: 'trusted hot path',
  },
  {
    locality: 'WASM',
    runtime: 'wasm',
    failureBoundary: 'sandboxed',
    portabilityTargets: ['WASM'],
    policy: 'restricted portable compute',
  },
  {
    locality: 'ISOLATED_PROCESS',
    runtime: 'rust-native',
    failureBoundary: 'worker-isolated',
    portabilityTargets: ['RUST_NATIVE', 'JS'],
    policy: 'risky/native/python or untrusted code',
  },
  {
    locality: 'REMOTE',
    runtime: 'remote-worker',
    failureBoundary: 'worker-isolated',
    portabilityTargets: ['REMOTE'],
    policy: 'heavy/external/provider-specific execution',
  },
].map((entry) => Object.freeze({ ...entry, portabilityTargets: Object.freeze(entry.portabilityTargets) })));

/**
 * The invariants P6 is built on, stated once so they can be asserted rather
 * than remembered. Each is a claim about the module, not a grant of anything.
 */
export const NODE_REGISTRY_RULES = Object.freeze(Object.freeze({
  identity: 'identity is type + typeVersion; displayName, package, vendor, language, runtime and trust never change it',
  authority: 'language, package origin, official status, AI authorship and the internal repository grant no trust',
  trust: 'trust classes are quoted from the foundation; a trust class never implies a capability',
  capability: 'capabilities are declared explicitly and validated against the foundation vocabulary',
  locality: 'runtime locality is declared; the host decides what it gets (foundation.json runtimes.selectionRule)',
  resources: 'a resource profile is metadata and policy input, never a scheduler',
  closure: 'unknown field, unknown trust, unknown capability, unknown runtime, unknown lifecycle: refused',
  determinism: 'equal declarations have equal digests regardless of key order, capability order or declaration order',
  residency: 'declared is not installed is not loaded is not active; this module only ever sees `declared`',
}));

/** Closed refusal vocabulary. No second error family: the code stays `lego.*`. */
export const NODE_REGISTRY_REASONS = Object.freeze([
  'registry.field',
  'registry.identity',
  'registry.trust',
  'registry.capability',
  'registry.locality',
  'registry.lifecycle',
  'registry.health',
  'registry.version',
  'registry.digest',
  'registry.provenance',
  'registry.resource',
  'registry.compatibility',
  'registry.discovery',
  'registry.duplicate',
]);

/* ------------------------------------------------------------------ *
 * Errors — the LEGO contract-violation family
 * ------------------------------------------------------------------ */

export class NodeRegistryError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NodeRegistryError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new NodeRegistryError(message, meta); };

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/* ------------------------------------------------------------------ *
 * Identity functions
 * ------------------------------------------------------------------ */

/** @returns {boolean} whether `value` is a canonical node type id. */
export function isNodeTypeId(value) {
  return typeof value === 'string' && NODE_TYPE_ID_RE.test(value);
}

/** @returns {boolean} whether `value` is a canonical node type version. */
export function isNodeTypeVersion(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && NODE_TYPE_VERSION_RE.test(String(value));
  }
  return typeof value === 'string' && NODE_TYPE_VERSION_RE.test(value);
}

/**
 * Renders the canonical identity of a node: `<type>@<typeVersion>`.
 * The identity string is what a workflow reference and the catalog agree on
 * (`n8n-nodes-base.httpRequest@4.4`), so it is produced here and nowhere else.
 *
 * @param {{ type: string, typeVersion: number|string }} identity
 * @returns {string}
 */
export function nodeIdentity({ type, typeVersion } = {}) {
  const result = validateNodeIdentity({ type, typeVersion });
  if (!result.ok) fail(`invalid node identity: ${result.errors.map((error) => error.message).join('; ')}`, { identity: { type, typeVersion } });
  return `${type}@${Number(typeVersion)}`;
}

/**
 * Parses a canonical identity back into its two parts.
 * @returns {{ type: string, typeVersion: number }|null} `null` when it is not one.
 */
export function parseNodeIdentity(identity) {
  if (typeof identity !== 'string' || !NODE_IDENTITY_RE.test(identity)) return null;
  const at = identity.lastIndexOf('@');
  return { type: identity.slice(0, at), typeVersion: Number(identity.slice(at + 1)) };
}

/**
 * Validates an identity without throwing — the declaration validator collects
 * every problem, and identity is one of them.
 * @returns {{ ok: boolean, errors: Array<{ code: string, field: string, message: string }> }}
 */
export function validateNodeIdentity({ type, typeVersion } = {}) {
  const errors = [];
  if (!isNodeTypeId(type)) {
    errors.push({
      code: 'registry.identity',
      field: 'type',
      message: `type must be a node type id such as 'n8n-nodes-base.httpRequest' (got ${JSON.stringify(type)})`,
    });
  }
  if (!isNodeTypeVersion(typeVersion)) {
    errors.push({
      code: 'registry.identity',
      field: 'typeVersion',
      message: `typeVersion must be a positive node version with at most one decimal place (got ${JSON.stringify(typeVersion)})`,
    });
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * Deterministic serialization
 * ------------------------------------------------------------------ */

/** Stable JSON: object keys sorted, arrays kept in their given order. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const digestOf = (canonicalJson) => `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`;

/**
 * Normalizes a declaration into its canonical form: known fields only, in
 * canonical order, with the order-insensitive collections sorted. Two
 * declarations that say the same thing canonicalize to the same bytes.
 */
export function canonicalNodeRegistryDeclaration(declaration) {
  if (!isPlainObject(declaration)) fail('a node registry declaration must be a plain object', { got: typeof declaration });
  const sortedList = (list) => (Array.isArray(list) ? [...list].sort() : list);
  const canonical = {};
  for (const field of NODE_REGISTRY_FIELDS) {
    if (!(field in declaration)) continue;
    const value = declaration[field];
    if (field === 'capabilities') canonical[field] = sortedList(value);
    else if (field === 'compatibility' && isPlainObject(value)) {
      canonical[field] = { ...value, portabilityTargets: sortedList(value.portabilityTargets ?? []) };
    } else if (field === 'resourceProfile' && isPlainObject(value)) {
      canonical[field] = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    } else if (isPlainObject(value)) {
      canonical[field] = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    } else canonical[field] = value;
  }
  for (const field of NODE_REGISTRY_OPTIONAL_FIELDS) {
    if (field in declaration) canonical[field] = declaration[field];
  }
  return Object.freeze(canonical);
}

/** Digest of one declaration's canonical form. */
export function nodeRegistryDeclarationDigest(declaration) {
  return digestOf(stableJson(canonicalNodeRegistryDeclaration(declaration)));
}

/* ------------------------------------------------------------------ *
 * Declaration validation — fail closed, every problem reported
 * ------------------------------------------------------------------ */

function validateProvenance(provenance, errors) {
  if (!isPlainObject(provenance)) {
    errors.push({ code: 'registry.provenance', field: 'provenance', message: 'provenance must be an object' });
    return;
  }
  if (!NODE_PROVENANCE_KINDS.includes(provenance.kind)) {
    errors.push({
      code: 'registry.provenance',
      field: 'provenance.kind',
      message: `provenance.kind must be one of ${NODE_PROVENANCE_KINDS.join(', ')} (got ${JSON.stringify(provenance.kind)})`,
    });
  }
  if (!isNonEmptyString(provenance.source)) {
    errors.push({ code: 'registry.provenance', field: 'provenance.source', message: 'provenance.source must be a non-empty string' });
  }
  if (provenance.kind === 'attested-build' && !isNonEmptyString(provenance.attestationRef)) {
    errors.push({
      code: 'registry.provenance',
      field: 'provenance.attestationRef',
      message: "an 'attested-build' declaration must name the attestation it relies on; P6.12 verifies it, nothing here assumes it",
    });
  }
}

function validateResourceProfile(profile, errors) {
  if (!isPlainObject(profile)) {
    errors.push({ code: 'registry.resource', field: 'resourceProfile', message: 'resourceProfile must be an object' });
    return;
  }
  for (const field of NODE_RESOURCE_FIELDS) {
    if (!(field in profile)) {
      errors.push({ code: 'registry.resource', field: `resourceProfile.${field}`, message: `resourceProfile is missing '${field}'` });
      continue;
    }
    const value = profile[field];
    if (field === 'network') {
      if (typeof value !== 'boolean') {
        errors.push({ code: 'registry.resource', field: 'resourceProfile.network', message: 'resourceProfile.network must be a boolean' });
      }
      continue;
    }
    if (field === 'concurrency') {
      if (!NODE_CONCURRENCY_MODES.includes(value)) {
        errors.push({
          code: 'registry.resource',
          field: 'resourceProfile.concurrency',
          message: `resourceProfile.concurrency must be one of ${NODE_CONCURRENCY_MODES.join(', ')} (got ${JSON.stringify(value)})`,
        });
      }
      continue;
    }
    const allowed = NODE_RESOURCE_CLASSES[field] ?? [];
    if (!allowed.includes(value)) {
      errors.push({
        code: 'registry.resource',
        field: `resourceProfile.${field}`,
        message: `resourceProfile.${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`,
      });
    }
  }
  for (const field of Object.keys(profile)) {
    if (!NODE_RESOURCE_FIELDS.includes(field)) {
      errors.push({ code: 'registry.resource', field: `resourceProfile.${field}`, message: `unknown resource field '${field}'` });
    }
  }
}

function validateCompatibility(compatibility, errors) {
  if (!isPlainObject(compatibility)) {
    errors.push({ code: 'registry.compatibility', field: 'compatibility', message: 'compatibility must be an object' });
    return;
  }
  if (typeof compatibility.contractRange !== 'string' || !RANGE_RE.test(compatibility.contractRange)) {
    errors.push({
      code: 'registry.compatibility',
      field: 'compatibility.contractRange',
      message: "compatibility.contractRange must be a declared range such as '^0.1.0' (resolution belongs to P6.2, not here)",
    });
  }
  const targets = compatibility.portabilityTargets;
  if (!Array.isArray(targets) || targets.length === 0) {
    errors.push({
      code: 'registry.compatibility',
      field: 'compatibility.portabilityTargets',
      message: 'compatibility.portabilityTargets must list at least one portability target',
    });
  } else {
    for (const target of targets) {
      if (!PORTABILITY_TARGETS.includes(target)) {
        errors.push({
          code: 'registry.compatibility',
          field: 'compatibility.portabilityTargets',
          message: `unknown portability target ${JSON.stringify(target)} — expected one of ${PORTABILITY_TARGETS.join(', ')}`,
        });
      }
    }
  }
  if ('kinds' in compatibility) {
    if (!Array.isArray(compatibility.kinds)) {
      errors.push({ code: 'registry.compatibility', field: 'compatibility.kinds', message: 'compatibility.kinds must be an array' });
    } else {
      for (const kind of compatibility.kinds) {
        if (!NODE_COMPATIBILITY_KINDS.includes(kind)) {
          errors.push({
            code: 'registry.compatibility',
            field: 'compatibility.kinds',
            message: `unknown compatibility kind ${JSON.stringify(kind)} — expected one of ${NODE_COMPATIBILITY_KINDS.join(', ')}`,
          });
        }
      }
    }
  }
}

function validateDiscovery(discovery, errors) {
  if (!isPlainObject(discovery)) {
    errors.push({ code: 'registry.discovery', field: 'discovery', message: 'discovery must be an object' });
    return;
  }
  if (!isNonEmptyString(discovery.displayName)) {
    errors.push({ code: 'registry.discovery', field: 'discovery.displayName', message: 'discovery.displayName must be a non-empty string' });
  }
  if (!NODE_DISCOVERY_GROUPS.includes(discovery.group)) {
    errors.push({
      code: 'registry.discovery',
      field: 'discovery.group',
      message: `discovery.group must be one of ${NODE_DISCOVERY_GROUPS.join(', ')} (got ${JSON.stringify(discovery.group)})`,
    });
  }
  if ('description' in discovery && typeof discovery.description !== 'string') {
    errors.push({ code: 'registry.discovery', field: 'discovery.description', message: 'discovery.description must be a string' });
  }
  if ('icon' in discovery && !isNonEmptyString(discovery.icon)) {
    errors.push({ code: 'registry.discovery', field: 'discovery.icon', message: 'discovery.icon must be a non-empty string' });
  }
  if ('keywords' in discovery) {
    if (!Array.isArray(discovery.keywords) || discovery.keywords.some((word) => typeof word !== 'string')) {
      errors.push({ code: 'registry.discovery', field: 'discovery.keywords', message: 'discovery.keywords must be an array of strings' });
    }
  }
}

/**
 * Validates one node registry declaration.
 *
 * Collects every problem instead of throwing on the first: a registry author
 * fixing a declaration needs the whole list, and a caller deciding admission
 * needs the reasons. `ok: false` always means "do not use this declaration".
 *
 * @returns {{ ok: boolean, errors: Array<{ code: string, field: string, message: string }> }}
 */
export function validateNodeRegistryDeclaration(declaration) {
  const errors = [];
  if (!isPlainObject(declaration)) {
    return { ok: false, errors: [{ code: 'registry.field', field: '(declaration)', message: 'a registry declaration must be a plain object' }] };
  }

  errors.push(...validateNodeIdentity({ type: declaration.type, typeVersion: declaration.typeVersion }).errors);

  for (const field of NODE_REGISTRY_REQUIRED_FIELDS) {
    // `type`/`typeVersion` are reported by validateNodeIdentity above, with the
    // identity-specific reason; reporting them twice would only add noise.
    if (field === 'type' || field === 'typeVersion') continue;
    if (!(field in declaration)) {
      errors.push({ code: 'registry.field', field, message: `declaration is missing required field '${field}'` });
    }
  }
  for (const field of Object.keys(declaration)) {
    if (!NODE_REGISTRY_FIELDS.includes(field) && !NODE_REGISTRY_OPTIONAL_FIELDS.includes(field)) {
      errors.push({
        code: 'registry.field',
        field,
        message: `unknown field '${field}' — the schema is closed; a new field is a contract change, not an extension`,
      });
    }
  }

  for (const [field, value] of [['package', declaration.package], ['packageVersion', declaration.packageVersion], ['vendor', declaration.vendor]]) {
    if (field in declaration && !isNonEmptyString(value)) {
      errors.push({ code: 'registry.field', field, message: `${field} must be a non-empty string` });
    }
  }

  for (const field of ['contractVersion', 'implementationVersion']) {
    if (field in declaration && (typeof declaration[field] !== 'string' || !SEMVER_RE.test(declaration[field]))) {
      errors.push({ code: 'registry.version', field, message: `${field} must be a semver string (got ${JSON.stringify(declaration[field])})` });
    }
  }

  if ('digest' in declaration && (typeof declaration.digest !== 'string' || !DIGEST_RE.test(declaration.digest))) {
    errors.push({ code: 'registry.digest', field: 'digest', message: "digest must be 'sha256:<64 hex>'; an unverifiable digest is not a digest" });
  }

  if ('trustClass' in declaration && !NODE_TRUST_CLASSES.includes(declaration.trustClass)) {
    errors.push({
      code: 'registry.trust',
      field: 'trustClass',
      message: `unknown trust class ${JSON.stringify(declaration.trustClass)} — expected one of ${NODE_TRUST_CLASSES.join(', ')}`,
    });
  }

  if ('runtimeLocality' in declaration && !NODE_RUNTIME_LOCALITIES.includes(declaration.runtimeLocality)) {
    errors.push({
      code: 'registry.locality',
      field: 'runtimeLocality',
      message: `unknown runtime locality ${JSON.stringify(declaration.runtimeLocality)} — expected one of ${NODE_RUNTIME_LOCALITIES.join(', ')}`,
    });
  }

  if ('lifecycle' in declaration && !NODE_LIFECYCLE_STATES.includes(declaration.lifecycle)) {
    errors.push({
      code: 'registry.lifecycle',
      field: 'lifecycle',
      message: `unknown lifecycle state ${JSON.stringify(declaration.lifecycle)} — expected one of ${NODE_LIFECYCLE_STATES.join(', ')}`,
    });
  }

  if ('health' in declaration && !NODE_HEALTH_STATES.includes(declaration.health)) {
    errors.push({
      code: 'registry.health',
      field: 'health',
      message: `unknown health state ${JSON.stringify(declaration.health)} — expected one of ${NODE_HEALTH_STATES.join(', ')}`,
    });
  }

  if ('capabilities' in declaration) {
    if (!Array.isArray(declaration.capabilities)) {
      errors.push({ code: 'registry.capability', field: 'capabilities', message: 'capabilities must be an array' });
    } else {
      for (const capability of declaration.capabilities) {
        if (!NODE_CAPABILITIES.includes(capability)) {
          errors.push({
            code: 'registry.capability',
            field: 'capabilities',
            message: `unknown capability ${JSON.stringify(capability)} — expected one of ${NODE_CAPABILITIES.join(', ')}`,
          });
        }
      }
    }
  }

  if ('notes' in declaration && typeof declaration.notes !== 'string') {
    errors.push({ code: 'registry.field', field: 'notes', message: 'notes must be a string' });
  }

  if ('provenance' in declaration) validateProvenance(declaration.provenance, errors);
  if ('resourceProfile' in declaration) validateResourceProfile(declaration.resourceProfile, errors);
  if ('compatibility' in declaration) validateCompatibility(declaration.compatibility, errors);
  if ('discovery' in declaration) validateDiscovery(declaration.discovery, errors);

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ *
 * Deterministic index — duplicate identities are refused, never merged
 * ------------------------------------------------------------------ */

/**
 * Builds the canonical index of a declaration set.
 *
 * There is no partial publication: when any declaration is invalid, or two
 * declarations claim the same identity, the result carries `ok: false` with
 * every reason and publishes nothing. A registry that lists a node twice is not
 * a registry with a precedence rule — it is an unresolved conflict.
 *
 * This is the deterministic dictionary, NOT the compiler: normalization,
 * epochs, atomic publication and rollback are P6.2, and no part of an epoch is
 * invented here.
 *
 * @param {Array<object>} declarations
 * @returns {{ ok: boolean, schemaVersion: number, count: number, identities: string[], byIdentity: object|null, indexDigest: string|null, errors: Array<object> }}
 */
export function indexNodeRegistryDeclarations(declarations) {
  if (!Array.isArray(declarations)) {
    fail('indexNodeRegistryDeclarations expects an array of declarations', { got: typeof declarations });
  }

  const errors = [];
  const byIdentity = new Map();

  declarations.forEach((declaration, position) => {
    const result = validateNodeRegistryDeclaration(declaration);
    if (!result.ok) {
      for (const error of result.errors) errors.push({ ...error, position });
      return;
    }
    const identity = `${declaration.type}@${Number(declaration.typeVersion)}`;
    const canonical = canonicalNodeRegistryDeclaration(declaration);
    if (byIdentity.has(identity)) {
      const first = byIdentity.get(identity);
      errors.push({
        code: 'registry.duplicate',
        field: 'type',
        position,
        message: `identity '${identity}' is declared twice (positions ${first.position} and ${position}); a duplicate identity is a conflict, not a precedence rule`,
      });
      return;
    }
    byIdentity.set(identity, { position, identity, declaration: canonical, digest: nodeRegistryDeclarationDigest(canonical) });
  });

  if (errors.length > 0) {
    return {
      ok: false,
      schemaVersion: NODE_REGISTRY_SCHEMA_VERSION,
      count: 0,
      identities: [],
      byIdentity: null,
      indexDigest: null,
      errors,
    };
  }

  const identities = [...byIdentity.keys()].sort();
  const frozenByIdentity = Object.freeze(
    Object.fromEntries(identities.map((identity) => [identity, byIdentity.get(identity)])),
  );
  const indexDigest = digestOf(stableJson(identities.map((identity) => [identity, byIdentity.get(identity).digest])));

  return {
    ok: true,
    schemaVersion: NODE_REGISTRY_SCHEMA_VERSION,
    count: identities.length,
    identities,
    byIdentity: frozenByIdentity,
    indexDigest,
    errors: [],
  };
}
