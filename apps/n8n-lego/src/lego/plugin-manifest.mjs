/**
 * Backend LEGO foundation — P2.27 plugin manifest validation.
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.2.0, owner: agent-1).
 *
 * A manifest is the plugin's *declared* boundary (design §5): identity,
 * version, publisher, the contract it satisfies, trust class, runtime class,
 * requested capabilities, optional resource limits / dependencies / supply
 * chain fields. Validation is **fail-closed and strict**: unknown fields,
 * unsupported range grammar, out-of-bounds arrays and malformed digests are
 * contract violations, because a lenient schema is how a hostile artifact
 * walks in wearing a friendly field name.
 *
 * Version grammar is NOT reimplemented here — ranges mean exactly what
 * `compat.mjs` (contract `compat`) means: `*`, exact `x.y.z`, `^` (0.x: same
 * minor), `~`, `>=`. Anything else fails validation instead of being silently
 * approximated.
 */
import { PluginRuntimeError, PLUGIN_TRUST_CLASSES, PLUGIN_RUNTIME_LOCALITIES } from './plugin-runtime.mjs';
import { parseVersion, satisfies } from './compat.mjs';

/** Required manifest fields — all six, always. */
export const PLUGIN_MANIFEST_REQUIRED = Object.freeze([
  'id',
  'version',
  'publisher',
  'contract',
  'trustClass',
  'runtimeClass',
  'requestedCapabilities',
]);

/** Optional manifest fields this schema knows about. Anything else is a violation. */
export const PLUGIN_MANIFEST_OPTIONAL = Object.freeze([
  'resourceLimits',
  'dependencies',
  'digest',
  'signature',
  'provenance',
  'sbom',
]);

/** Declared resource-limit keys (design §14 names, snake camel-bound). Values are bounded integers. */
export const PLUGIN_RESOURCE_LIMIT_FIELDS = Object.freeze([
  'cpuMillis',
  'memoryMb',
  'concurrency',
  'queueDepth',
  'timeoutMs',
  'outputBytes',
  'processCount',
]);

/** Bounds — a manifest cannot declare unbounded anything (Master Prompt §63). */
export const PLUGIN_MANIFEST_BOUNDS = Object.freeze({
  idMinLength: 2,
  idMaxLength: 64,
  publisherMaxLength: 128,
  capabilitiesMax: 32,
  dependenciesMax: 64,
  resourceValueMax: 1_000_000_000,
  blobMaxLength: 1024,
});

const ID_RE = /^[a-z][a-z0-9-]*$/;
const DOTTED_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });

function assertPlainObject(value, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw violation(`manifest ${where} must be a plain object`, { where });
  }
}

function assertString(value, where, { max = 256, pattern = null } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw violation(`manifest ${where} must be a string of length [1, ${max}]`, { where });
  }
  if (pattern && !pattern.test(value)) throw violation(`manifest ${where} has malformed value`, { where });
}

function assertRange(range, where) {
  assertString(range, where, { max: 64 });
  try {
    // Probe with a concrete version: an unsupported grammar throws in
    // compat.mjs, which is exactly the fail-closed answer we want.
    satisfies('999.0.0', range);
  } catch {
    throw violation(
      `manifest ${where} uses a range grammar compat.mjs does not publish (expected *, x.y.z, ^, ~, or >=)`,
      { where, range },
    );
  }
}

/**
 * Validate and normalize a plugin manifest. Returns a frozen deep-ish copy
 * (arrays/nested objects replaced with frozen copies); the input is never
 * mutated. Throws `lego.contract_violation` on any deviation.
 *
 * @param {object} manifest
 */
export function validateManifest(manifest) {
  assertPlainObject(manifest, 'root');

  const known = new Set([...PLUGIN_MANIFEST_REQUIRED, ...PLUGIN_MANIFEST_OPTIONAL]);
  const unknown = Object.keys(manifest).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw violation(`manifest declares unknown field(s): ${unknown.join(', ')}`, { unknown });
  }
  for (const field of PLUGIN_MANIFEST_REQUIRED) {
    if (manifest[field] === undefined) throw violation(`manifest is missing required field '${field}'`, { field });
  }

  const { id, version, publisher, contract, trustClass, runtimeClass, requestedCapabilities } = manifest;

  assertString(id, 'id', { max: PLUGIN_MANIFEST_BOUNDS.idMaxLength, pattern: ID_RE });
  if (id.length < PLUGIN_MANIFEST_BOUNDS.idMinLength) throw violation('manifest id is too short', { id });

  assertString(version, 'version', { max: 32 });
  try {
    parseVersion(version);
  } catch {
    throw violation(`manifest version '${version}' is not major.minor.patch`, { version });
  }

  assertString(publisher, 'publisher', { max: PLUGIN_MANIFEST_BOUNDS.publisherMaxLength });

  assertPlainObject(contract, 'contract');
  const contractKeys = Object.keys(contract);
  if (contractKeys.length !== 2 || !contractKeys.includes('id') || !contractKeys.includes('range')) {
    throw violation("manifest contract must be exactly { id, range }", { contractKeys });
  }
  assertString(contract.id, 'contract.id', { max: 128, pattern: DOTTED_ID_RE });
  assertRange(contract.range, 'contract.range');
  const contractFrozen = Object.freeze({ id: contract.id, range: contract.range });

  if (typeof trustClass !== 'string' || !PLUGIN_TRUST_CLASSES.includes(trustClass)) {
    throw violation(`manifest trustClass must be one of ${PLUGIN_TRUST_CLASSES.join('/')}`, {
      trustClass,
      declared: PLUGIN_TRUST_CLASSES,
    });
  }
  if (typeof runtimeClass !== 'string' || !PLUGIN_RUNTIME_LOCALITIES.includes(runtimeClass)) {
    throw violation(`manifest runtimeClass must be one of ${PLUGIN_RUNTIME_LOCALITIES.join('/')}`, {
      runtimeClass,
      declared: PLUGIN_RUNTIME_LOCALITIES,
    });
  }

  if (!Array.isArray(requestedCapabilities)) throw violation('manifest requestedCapabilities must be an array');
  if (requestedCapabilities.length > PLUGIN_MANIFEST_BOUNDS.capabilitiesMax) {
    throw violation(`manifest requestedCapabilities exceeds ${PLUGIN_MANIFEST_BOUNDS.capabilitiesMax} entries`, {
      count: requestedCapabilities.length,
    });
  }
  const capabilities = [];
  for (const capability of requestedCapabilities) {
    if (typeof capability !== 'string' || capability.length > 64 || !CAPABILITY_RE.test(capability)) {
      throw violation(`manifest capability '${String(capability)}' is malformed`, { capability });
    }
    if (capabilities.includes(capability)) throw violation(`manifest repeats capability '${capability}'`, { capability });
    capabilities.push(capability);
  }
  const capabilitiesFrozen = Object.freeze([...capabilities]);

  let resourceLimitsFrozen = undefined;
  if (manifest.resourceLimits !== undefined) {
    assertPlainObject(manifest.resourceLimits, 'resourceLimits');
    for (const [key, value] of Object.entries(manifest.resourceLimits)) {
      if (!PLUGIN_RESOURCE_LIMIT_FIELDS.includes(key)) {
        throw violation(`manifest resourceLimits declares unknown field '${key}'`, { key });
      }
      if (!Number.isInteger(value) || value < 0 || value > PLUGIN_MANIFEST_BOUNDS.resourceValueMax) {
        throw violation(`manifest resourceLimits.${key} must be an integer in [0, ${PLUGIN_MANIFEST_BOUNDS.resourceValueMax}]`, {
          key,
          value,
        });
      }
    }
    resourceLimitsFrozen = Object.freeze({ ...manifest.resourceLimits });
  }

  let dependenciesFrozen = undefined;
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) throw violation('manifest dependencies must be an array');
    if (manifest.dependencies.length > PLUGIN_MANIFEST_BOUNDS.dependenciesMax) {
      throw violation(`manifest dependencies exceeds ${PLUGIN_MANIFEST_BOUNDS.dependenciesMax} entries`, {
        count: manifest.dependencies.length,
      });
    }
    const seen = new Set();
    const dependencies = [];
    manifest.dependencies.forEach((dependency, index) => {
      assertPlainObject(dependency, `dependencies[${index}]`);
      const keys = Object.keys(dependency);
      if (keys.length !== 2 || !keys.includes('id') || !keys.includes('range')) {
        throw violation(`manifest dependencies[${index}] must be exactly { id, range }`, { keys });
      }
      assertString(dependency.id, `dependencies[${index}].id`, { max: 128, pattern: DOTTED_ID_RE });
      assertRange(dependency.range, `dependencies[${index}].range`);
      if (seen.has(dependency.id)) throw violation(`manifest repeats dependency '${dependency.id}'`, { id: dependency.id });
      seen.add(dependency.id);
      dependencies.push(Object.freeze({ id: dependency.id, range: dependency.range }));
    });
    dependenciesFrozen = Object.freeze(dependencies);
  }

  for (const blobField of ['digest', 'signature', 'provenance', 'sbom']) {
    const value = manifest[blobField];
    if (value === undefined) continue;
    if (blobField === 'digest') {
      assertString(value, 'digest', { max: 71, pattern: DIGEST_RE });
    } else {
      assertString(value, blobField, { max: PLUGIN_MANIFEST_BOUNDS.blobMaxLength });
    }
  }

  const normalized = {
    id,
    version,
    publisher,
    contract: contractFrozen,
    trustClass,
    runtimeClass,
    requestedCapabilities: capabilitiesFrozen,
  };
  if (resourceLimitsFrozen) normalized.resourceLimits = resourceLimitsFrozen;
  if (dependenciesFrozen) normalized.dependencies = dependenciesFrozen;
  for (const blobField of ['digest', 'signature', 'provenance', 'sbom']) {
    if (manifest[blobField] !== undefined) normalized[blobField] = manifest[blobField];
  }
  return Object.freeze(normalized);
}
