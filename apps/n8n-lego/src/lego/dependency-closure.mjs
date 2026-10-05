/**
 * Dependency closure + content-addressed artifact store — P6.4.
 *
 * PUBLIC CONTRACT (`registry.closure@0.1.0`, domain `node-registry`).
 *
 * P6.3 gives an install a journal and a fence. It installs ONE package. Real
 * node packages do not arrive alone: `n8n-nodes-base` pulls helpers, a community
 * package pulls a parser, and the parser pulls a runtime. So before the
 * transaction starts, something has to answer three questions — which packages
 * are actually needed, in which versions, and whether the bytes on hand are the
 * bytes the registry says they are.
 *
 * This module answers all three, purely:
 *
 *   1. RESOLUTION. Given a root package and a catalogue of published versions,
 *      produce the full dependency closure: a deterministic, topologically
 *      ordered list of `package@version` plus the digest each one must have.
 *      Deterministic means two hosts resolving the same catalogue with the same
 *      root get byte-identical results, because a closure that depends on map
 *      iteration order is not a closure, it is a coin flip.
 *
 *   2. STORE ADDRESSING. Content-addressed, not name-addressed: the address of
 *      an artifact IS `sha256` of its content. Two identical payloads share one
 *      address and cannot disagree about it, which is what makes deduplication
 *      safe rather than clever, and what makes "the same bytes" a checkable
 *      claim instead of a promise.
 *
 *   3. VERIFICATION. A stored artifact whose content no longer hashes to its
 *      address is refused (`closure.digest`). Nothing is silently re-addressed:
 *      corruption is not an upgrade.
 *
 * What resolution refuses, because each of these has burned a real supply chain:
 *   - an unmet REQUIRED dependency (installing a package without what it needs);
 *   - a requirement no published version satisfies (silently picking a nearby
 *     version is how a security fix gets skipped);
 *   - a cycle (a closure that cannot be ordered cannot be installed in order);
 *   - a closure deeper than the bound (unbounded graph walk);
 *   - two requirements that no single version satisfies (a real conflict, not a
 *     preference to break);
 *   - an OPTIONAL dependency that is declared but broken is reported, never
 *     waved through as if it were fine — optional means "may be absent", not
 *     "may be wrong".
 *
 * WHAT THIS IS NOT (P6.4 scope walls, enforced by tests):
 *   - no network and no filesystem: the catalogue is DATA handed in, which is
 *     why the same resolution is reproducible in a test and on a ship;
 *   - no install, no journal, no fence (P6.3 owns those) — this module produces
 *     the closure a transaction then installs, never a transaction;
 *   - no workflow pinning (P6.5), no lease (P6.6), no signature or attestation
 *     (P6.12/P6.27): an address proves identity, never authorship or goodwill;
 *   - no trust decision, and no capability: a verified digest is a fact about
 *     bytes, not an admission to run them;
 *   - no mutation: every operation returns a new frozen value.
 *
 * Semver subset, stated rather than assumed: `*`, exact (`1.2.3`), caret
 * (`^1.2.3`) and tilde (`~1.2.3`) over `major.minor.patch` with an optional
 * pre-release tag. Pre-releases are never selected unless the requirement names
 * the same pre-release, which is the behaviour a stable registry needs and the
 * reason the subset is documented here instead of imported.
 */
import { createHash } from 'node:crypto';

import { NODE_REGISTRY_SCHEMA_VERSION } from './node-registry.mjs';

export const DEPENDENCY_CLOSURE_CONTRACT = 'registry.closure@0.1.0';
export const DEPENDENCY_CLOSURE_CONTRACT_VERSION = '0.1.0';
export const DEPENDENCY_CLOSURE_SCHEMA_VERSION = 1;

export const DEPENDENCY_CLOSURE_OPERATIONS = Object.freeze(['resolve', 'store', 'verify', 'plan']);
export const DEPENDENCY_CLOSURE_PERMISSIONS = Object.freeze(['node:read']);

/** Dependency edge kinds. `optional` may be absent; `conflict` may never be present. */
export const DEPENDENCY_KINDS = Object.freeze(['runtime', 'optional', 'peer', 'conflict']);

/** Bounds: a graph walk without a ceiling is a denial-of-service waiting to happen. */
export const CLOSURE_MAX_DEPTH = 32;
export const CLOSURE_MAX_PACKAGES = 512;

export const DEPENDENCY_CLOSURE_REASONS = Object.freeze([
  'closure.identity',
  'closure.range',
  'closure.missing',
  'closure.unsatisfied',
  'closure.conflict',
  'closure.cycle',
  'closure.depth',
  'closure.size',
  'closure.duplicate',
  'closure.digest',
  'closure.address',
  'closure.store',
]);

export const DEPENDENCY_CLOSURE_RULES = Object.freeze({
  deterministic: 'resolution depends on the catalogue and the root only — never on map order, insertion order or the host',
  addressing: 'an address IS the hash of the content: identical bytes share one address and cannot disagree about it',
  verification: 'content that no longer hashes to its address is refused; corruption is never re-addressed',
  required: 'a required dependency that cannot be resolved fails the whole closure; there is no best-effort subset',
  optional: 'an optional dependency may be ABSENT, but if it is declared and broken that is reported, not waved through',
  conflicts: 'two requirements no single version satisfies are a conflict to report, never a preference to break',
  order: 'the closure is topologically ordered, so installing it in order always installs a dependency first',
  authority: 'an address proves identity of bytes; it proves nothing about authorship, trust or permission',
});

/* ------------------------------------------------------------------ *\n * Errors\n * ------------------------------------------------------------------ */

export class DependencyClosureError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'DependencyClosureError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new DependencyClosureError(message, meta); };
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const digestOf = (text) => createHash('sha256').update(text).digest('hex');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/* ------------------------------------------------------------------ *\n * Versions\n * ------------------------------------------------------------------ */

const parseVersion = (value) => {
  if (typeof value !== 'string') return null;
  const match = VERSION_RE.exec(value);
  if (!match) return null;
  return { raw: value, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
};

const compareVersions = (a, b) => (
  a.major - b.major || a.minor - b.minor || a.patch - b.patch
  || (a.prerelease === b.prerelease ? 0 : a.prerelease === null ? 1 : b.prerelease === null ? -1 : (a.prerelease < b.prerelease ? -1 : 1))
);

/** Parse a requirement into a comparable predicate. No range grammar is invented here. */
function parseRange(range) {
  if (typeof range !== 'string' || range.trim().length === 0) return null;
  const text = range.trim();
  if (text === '*' || text === '' || text === 'latest') return { raw: text, kind: 'any', test: (version) => version.prerelease === null };
  const operator = text[0];
  if (operator === '^' || operator === '~') {
    const base = parseVersion(text.slice(1));
    if (!base) return null;
    if (operator === '^') {
      const upper = base.major > 0
        ? { major: base.major + 1, minor: 0, patch: 0 }
        : base.minor > 0
          ? { major: 0, minor: base.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: base.patch + 1 };
      return {
        raw: text,
        kind: 'caret',
        test: (version) => compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0,
      };
    }
    const upper = { major: base.major, minor: base.minor + 1, patch: 0 };
    return {
      raw: text,
      kind: 'tilde',
      test: (version) => compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0,
    };
  }
  const exact = parseVersion(text);
  if (!exact) return null;
  return { raw: text, kind: 'exact', test: (version) => version.raw === exact.raw };
}

/* ------------------------------------------------------------------ *\n * Catalogue\n * ------------------------------------------------------------------ */

function normalizeCatalogue(catalogue) {
  if (!isPlainObject(catalogue)) fail('resolveDependencyClosure expects a catalogue object mapping package names to published versions', { got: typeof catalogue });
  const normalized = new Map();
  for (const name of Object.keys(catalogue)) {
    if (!PACKAGE_NAME_RE.test(name)) fail(`catalogue contains invalid package name '${name}'`, { code: 'closure.identity', field: name });
    const versions = catalogue[name];
    if (!isPlainObject(versions)) fail(`catalogue entry '${name}' must map versions to metadata`, { code: 'closure.identity', field: name });
    const parsed = new Map();
    for (const version of Object.keys(versions)) {
      const entry = versions[version];
      const parsedVersion = parseVersion(version);
      if (!parsedVersion) fail(`catalogue lists invalid version '${name}@${version}'`, { code: 'closure.identity', field: version });
      if (!isPlainObject(entry)) fail(`catalogue entry '${name}@${version}' must be an object`, { code: 'closure.identity' });
      const digest = entry.digest;
      if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
        fail(`catalogue entry '${name}@${version}' has no verifiable digest`, { code: 'closure.digest', field: 'digest' });
      }
      const dependencies = entry.dependencies ?? [];
      if (!Array.isArray(dependencies)) fail(`dependencies of '${name}@${version}' must be an array`, { code: 'closure.identity' });
      const seen = new Set();
      const edges = dependencies.map((dependency) => {
        if (!isPlainObject(dependency) || !isNonEmptyString(dependency.package) || !PACKAGE_NAME_RE.test(dependency.package)) {
          fail(`'${name}@${version}' declares an invalid dependency`, { code: 'closure.identity', field: 'dependencies' });
        }
        const kind = dependency.kind ?? 'runtime';
        if (!DEPENDENCY_KINDS.includes(kind)) {
          fail(`'${name}@${version}' declares dependency kind '${kind}'; kinds are ${DEPENDENCY_KINDS.join(', ')}`, { code: 'closure.identity', field: 'kind' });
        }
        const range = parseRange(dependency.range ?? '*');
        if (!range) fail(`'${name}@${version}' declares unparseable range ${JSON.stringify(dependency.range)} for '${dependency.package}'`, { code: 'closure.range', field: dependency.package });
        if (seen.has(dependency.package)) fail(`'${name}@${version}' declares '${dependency.package}' twice`, { code: 'closure.duplicate', field: dependency.package });
        seen.add(dependency.package);
        return deepFreeze({ package: dependency.package, range, kind });
      });
      parsed.set(version, deepFreeze({ package: name, version, digest, dependencies: edges, published: true }));
    }
    normalized.set(name, parsed);
  }
  return normalized;
}

/* ------------------------------------------------------------------ *\n * Resolution\n * ------------------------------------------------------------------ */

/** Depth-first cycle search over the resolved graph. Returns the cycle path, or null. */
function findDependencyCycle(resolved) {
  const state = new Map(); // 0 = unvisited, 1 = on the stack, 2 = finished
  let found = null;
  const visit = (name, path) => {
    if (found || state.get(name) === 2) return;
    if (state.get(name) === 1) {
      found = [...path.slice(path.indexOf(name)), name];
      return;
    }
    state.set(name, 1);
    for (const edge of resolved.get(name).dependencies) {
      if (edge.kind === 'conflict' || !resolved.has(edge.package)) continue;
      visit(edge.package, [...path, name]);
    }
    state.set(name, 2);
  };
  for (const name of [...resolved.keys()].sort()) visit(name, []);
  return found;
}

const selectVersion = (available, requirements) => {
  const candidates = [...available.keys()].map(parseVersion).filter(Boolean).sort(compareVersions).reverse();
  const accepted = candidates.filter((version) => {
    // A pre-release is only ever selected when a requirement NAMES it: a caret
    // range that happens to cover `1.1.0-beta.1` must not install a beta.
    if (version.prerelease !== null && !requirements.some((range) => range.kind === 'exact' && range.raw === version.raw)) return false;
    return requirements.every((range) => range.test(version));
  });
  return accepted.length > 0 ? accepted[0] : null;
};

/**
 * Resolve the full dependency closure of `root`.
 *
 * @param {{ root?: { package: string, range?: string }, catalogue?: object, maxDepth?: number }} input
 * @returns {Readonly<object>} `{ ok, order, packages, digest, depth, optionalMissing, warnings }`,
 *   or `{ ok:false, reason, errors }` — never a partial closure.
 */
export function resolveDependencyClosure(input = {}) {
  const { root, catalogue, maxDepth = CLOSURE_MAX_DEPTH } = isPlainObject(input) ? input : {};
  const schemaVersion = DEPENDENCY_CLOSURE_SCHEMA_VERSION;

  if (!isPlainObject(root) || !isNonEmptyString(root.package) || !PACKAGE_NAME_RE.test(root.package)) {
    fail('resolveDependencyClosure expects a root { package, range? }', { code: 'closure.identity', field: 'root' });
  }
  const rootRange = parseRange(root.range ?? '*');
  if (!rootRange) fail(`root range ${JSON.stringify(root.range)} is unparseable`, { code: 'closure.range', field: 'root.range' });
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > CLOSURE_MAX_DEPTH) {
    fail(`maxDepth must be an integer between 1 and ${CLOSURE_MAX_DEPTH}`, { code: 'closure.depth', field: 'maxDepth' });
  }

  const catalogueIndex = normalizeCatalogue(catalogue);
  const requirements = new Map([[root.package, [{ range: rootRange, requiredBy: '(root)', kind: 'runtime' }]]]);
  const resolved = new Map();
  const declaredConflicts = [];
  const optionalMissing = [];
  const warnings = [];
  const errors = [];

  const satisfy = (name, dependencyRequirements) => {
    const available = catalogueIndex.get(name);
    if (!available || available.size === 0) return { version: null, reason: 'absent' };
    const version = selectVersion(available, dependencyRequirements.map((requirement) => requirement.range));
    return version ? { version: version.raw, reason: null } : { version: null, reason: 'range' };
  };

  // Breadth-first with a depth ceiling and an explicit order, so a cycle is
  // detected instead of walked forever.
  let frontier = [root.package];
  const depthOf = new Map([[root.package, 0]]);
  const visiting = new Set();

  const rootChoice = satisfy(root.package, requirements.get(root.package));
  if (!rootChoice.version) {
    const message = rootChoice.reason === 'absent'
      ? `root package '${root.package}' is not in the catalogue`
      : `no published version of '${root.package}' satisfies ${rootRange.raw}`;
    return deepFreeze({ ok: false, schemaVersion, reason: rootChoice.reason === 'absent' ? 'closure.missing' : 'closure.unsatisfied', order: [], packages: {}, digest: null, errors: [{ code: rootChoice.reason === 'absent' ? 'closure.missing' : 'closure.unsatisfied', field: root.package, message }], optionalMissing: [], warnings: [] });
  }
  resolved.set(root.package, catalogueIndex.get(root.package).get(rootChoice.version));

  while (frontier.length > 0) {
    const next = [];
    for (const name of frontier) {
      const depth = depthOf.get(name) ?? 0;
      if (depth >= maxDepth) {
        errors.push({ code: 'closure.depth', field: name, message: `dependency depth ${depth} reached the ceiling ${maxDepth}; the graph is deeper than this contract will walk` });
        continue;
      }
      const entry = resolved.get(name);
      for (const edge of entry.dependencies) {
        if (edge.kind === 'conflict') {
          // Checked AFTER the closure is complete: whether a conflict fires
          // depends on the whole graph, not on what has been walked so far.
          declaredConflicts.push({ declarer: name, edge });
          continue;
        }
        const existing = requirements.get(edge.package) ?? [];
        existing.push({ range: edge.range, requiredBy: name, kind: edge.kind });
        requirements.set(edge.package, existing);

        const choice = satisfy(edge.package, existing);
        if (!choice.version) {
          if (edge.kind === 'optional') {
            optionalMissing.push({ package: edge.package, requiredBy: name, range: edge.range.raw, reason: choice.reason });
            continue;
          }
          // A required edge that the catalogue cannot satisfy is a closure
          // failure, reported with who asked for what — never a best effort.
          const message = choice.reason === 'absent'
            ? `'${name}' requires '${edge.package}' ${edge.range.raw} but it is not published in the catalogue`
            : `'${name}' requires '${edge.package}' ${edge.range.raw} and no published version satisfies it`;
          errors.push({ code: choice.reason === 'absent' ? 'closure.missing' : 'closure.unsatisfied', field: edge.package, message });
          continue;
        }
        const previous = resolved.get(edge.package);
        if (previous && previous.version !== choice.version) {
          errors.push({
            code: 'closure.conflict',
            field: edge.package,
            message: `'${edge.package}' is required at ${previous.version} and at ${choice.version} by '${name}'; a closure has one version per package`,
          });
          continue;
        }
        if (!previous) {
          resolved.set(edge.package, catalogueIndex.get(edge.package).get(choice.version));
          depthOf.set(edge.package, depth + 1);
          next.push(edge.package);
        } else if (!resolved.has(edge.package)) {
          next.push(edge.package);
        }
      }
      visiting.delete(name);
    }
    if (resolved.size > CLOSURE_MAX_PACKAGES) {
      return deepFreeze({
        ok: false, schemaVersion, reason: 'closure.size', order: [], packages: {}, digest: null, optionalMissing: [], warnings: [],
        errors: [...errors, { code: 'closure.size', message: `closure reached ${resolved.size} packages, past the ceiling of ${CLOSURE_MAX_PACKAGES}` }],
      });
    }
    frontier = [...new Set(next)].sort();
  }

  for (const { declarer, edge } of declaredConflicts) {
    if (resolved.has(edge.package)) {
      errors.push({
        code: 'closure.conflict',
        field: edge.package,
        message: `'${declarer}' declares a conflict with '${edge.package}', which the closure requires`,
      });
    }
  }

  if (errors.length > 0) {
    return deepFreeze({ ok: false, schemaVersion, reason: errors[0].code, order: [], packages: {}, digest: null, errors, optionalMissing: Object.freeze(optionalMissing), warnings: Object.freeze(warnings) });
  }

  // A cycle is a property of the CONTENT, not a misuse of the API, so it is
  // refused with the cycle named — the same shape as every other refusal here.
  const cycle = findDependencyCycle(resolved);
  if (cycle) {
    return deepFreeze({
      ok: false,
      schemaVersion,
      reason: 'closure.cycle',
      order: [],
      packages: {},
      digest: null,
      optionalMissing: Object.freeze(optionalMissing),
      warnings: Object.freeze(warnings),
      errors: [{
        code: 'closure.cycle',
        field: cycle[0],
        message: `dependency cycle through ${cycle.join(' → ')}; a closure that cannot be ordered cannot be installed in order`,
        cycle: Object.freeze([...cycle]),
      }],
    });
  }

  // Topological order, dependency first, ties broken by name: the order an
  // installer must follow, and the same one on every host.
  const ordered = [];
  const visited = new Set();
  const walk = (name) => {
    if (visited.has(name)) return;
    const entry = resolved.get(name);
    for (const edge of entry.dependencies) {
      if (edge.kind === 'conflict' || !resolved.has(edge.package)) continue;
      walk(edge.package);
    }
    visited.add(name);
    ordered.push(name);
  };
  for (const name of [...resolved.keys()].sort()) walk(name);

  const packages = {};
  for (const name of ordered) {
    const entry = resolved.get(name);
    packages[name] = deepFreeze({
      name, version: entry.version, digest: entry.digest, depth: depthOf.get(name) ?? 0,
      requiredBy: Object.freeze((requirements.get(name) ?? []).map((requirement) => requirement.requiredBy).filter((value) => value !== name).sort()),
      kind: (requirements.get(name) ?? []).some((requirement) => requirement.kind === 'optional') ? 'optional' : 'runtime',
    });
  }

  const digest = digestOf(stableJson(ordered.map((name) => [name, packages[name].version, packages[name].digest])));
  return deepFreeze({
    ok: true,
    schemaVersion,
    contract: DEPENDENCY_CLOSURE_CONTRACT,
    root: Object.freeze({ package: root.package, version: packages[root.package].version, range: rootRange.raw }),
    order: Object.freeze(ordered.map((name) => `${name}@${packages[name].version}`)),
    packages: deepFreeze(packages),
    digest,
    count: ordered.length,
    depth: Math.max(...ordered.map((name) => packages[name].depth)),
    optionalMissing: Object.freeze(optionalMissing),
    warnings: Object.freeze(warnings),
    errors: Object.freeze([]),
    reason: null,
  });
}

/** @returns {boolean} whether `value` is a closure this contract produced. */
export function isDependencyClosure(value) {
  return (
    isPlainObject(value) &&
    value.ok === true &&
    value.contract === DEPENDENCY_CLOSURE_CONTRACT &&
    value.schemaVersion === DEPENDENCY_CLOSURE_SCHEMA_VERSION &&
    Array.isArray(value.order) &&
    isPlainObject(value.packages) &&
    typeof value.digest === 'string' &&
    Object.isFrozen(value)
  );
}

/** The install plan a closure implies: ordered package@version + digest pairs. */
export function closureInstallPlan(closure) {
  if (!isDependencyClosure(closure)) fail('closureInstallPlan expects a resolved closure', { got: typeof closure });
  return deepFreeze(closure.order.map((identity) => {
    const name = identity.slice(0, identity.lastIndexOf('@'));
    const entry = closure.packages[name];
    return { identity, name, version: entry.version, digest: entry.digest, depth: entry.depth, kind: entry.kind };
  }));
}

/** Which packages a closure requires that a set of installed identities does not have. */
export function missingFromClosure(closure, installed) {
  if (!isDependencyClosure(closure)) fail('missingFromClosure expects a resolved closure', { got: typeof closure });
  if (!Array.isArray(installed) && !(installed instanceof Set)) fail('missingFromClosure expects an array or Set of installed identities', { got: typeof installed });
  const have = new Set(installed);
  return deepFreeze(closure.order.filter((identity) => !have.has(identity)));
}

/* ------------------------------------------------------------------ *\n * Content-addressed store\n * ------------------------------------------------------------------ */

/** The address of content IS the hash of its content. Same bytes, same address. */
export function contentAddress(content) {
  if (typeof content === 'string') return `sha256:${digestOf(content)}`;
  if (content instanceof Uint8Array) return `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (content === undefined) fail('contentAddress expects a string or Uint8Array', { code: 'closure.address' });
  return `sha256:${digestOf(stableJson(content))}`;
}

/** A frozen, empty store. Keyed by address, never by name. */
export function createArtifactStore() {
  return deepFreeze({ ok: true, contract: DEPENDENCY_CLOSURE_CONTRACT, addresses: {}, count: 0, stored: 0, deduplicated: 0 });
}

const requireStore = (store, fn) => {
  if (!isPlainObject(store) || store.ok !== true || store.contract !== DEPENDENCY_CLOSURE_CONTRACT || !isPlainObject(store.addresses)) {
    fail(`${fn} expects a store produced by createArtifactStore`, { got: typeof store });
  }
};

/**
 * Store content under its own address.
 * @returns {{ ok: true, store: object, address: string, stored: boolean, deduplicated: boolean }}
 */
export function storeArtifact(store, content) {
  requireStore(store, 'storeArtifact');
  const address = contentAddress(content);
  if (Object.hasOwn(store.addresses, address)) {
    return Object.freeze({
      ok: true, store: deepFreeze({ ...store, deduplicated: store.deduplicated + 1 }), address, stored: false, deduplicated: true,
    });
  }
  const size = typeof content === 'string' ? content.length : content instanceof Uint8Array ? content.length : stableJson(content).length;
  const entry = deepFreeze({ address, size, kind: typeof content === 'string' ? 'text' : content instanceof Uint8Array ? 'bytes' : 'json' });
  return Object.freeze({
    ok: true,
    store: deepFreeze({ ...store, addresses: { ...store.addresses, [address]: entry }, count: store.count + 1, stored: store.stored + 1, deduplicated: store.deduplicated }),
    address,
    stored: true,
    deduplicated: false,
  });
}

export function hasArtifact(store, address) {
  requireStore(store, 'hasArtifact');
  return Object.hasOwn(store.addresses, address);
}

export function getArtifact(store, address) {
  requireStore(store, 'getArtifact');
  return Object.hasOwn(store.addresses, address) ? store.addresses[address] : null;
}

/**
 * Verify content against the address it is claimed under.
 * A mismatch is refused; the store is never re-addressed behind the caller.
 */
export function verifyArtifact(store, address, content) {
  requireStore(store, 'verifyArtifact');
  if (typeof address !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(address)) {
    return Object.freeze({ ok: false, reason: 'closure.address', expected: null, actual: null, message: `'${address}' is not a content address` });
  }
  const actual = contentAddress(content);
  if (actual !== address) {
    return Object.freeze({
      ok: false, reason: 'closure.digest', expected: address, actual,
      message: `content hashes to ${actual.slice(0, 19)}… but is claimed as ${address.slice(0, 19)}…; corruption is not an upgrade`,
    });
  }
  if (!Object.hasOwn(store.addresses, address)) {
    return Object.freeze({ ok: false, reason: 'closure.store', expected: address, actual, message: 'content is intact but is not in this store' });
  }
  return Object.freeze({ ok: true, reason: null, expected: address, actual, message: null });
}

/** Serializable inventory: sorted addresses, count and one digest over the whole store. */
export function artifactStoreManifest(store) {
  requireStore(store, 'artifactStoreManifest');
  const addresses = Object.keys(store.addresses).sort();
  return deepFreeze({
    contract: DEPENDENCY_CLOSURE_CONTRACT,
    count: addresses.length,
    addresses,
    sizes: Object.fromEntries(addresses.map((address) => [address, store.addresses[address].size])),
    digest: digestOf(stableJson(addresses.map((address) => [address, store.addresses[address].size]))),
    deduplicated: store.deduplicated,
  });
}

/**
 * Remove only what the caller declares dead. Nothing is collected by guessing:
 * an address that is still live is never touched, and the live set is required.
 */
export function collectArtifactGarbage(store, liveAddresses) {
  requireStore(store, 'collectArtifactGarbage');
  if (!Array.isArray(liveAddresses) && !(liveAddresses instanceof Set)) {
    fail('collectArtifactGarbage requires the live address set; garbage collection without a live set is data loss with a spec', { code: 'closure.store', field: 'liveAddresses' });
  }
  const live = new Set(liveAddresses);
  const removed = Object.keys(store.addresses).filter((address) => !live.has(address)).sort();
  if (removed.length === 0) return Object.freeze({ ok: true, store, removed: Object.freeze([]), freed: 0 });
  const addresses = { ...store.addresses };
  let freed = 0;
  for (const address of removed) {
    freed += addresses[address].size;
    delete addresses[address];
  }
  return Object.freeze({
    ok: true, store: deepFreeze({ ...store, addresses, count: Object.keys(addresses).length }), removed: Object.freeze(removed), freed,
  });
}

/** Verify a whole closure is present and intact in a store. */
export function verifyClosureAgainstStore(closure, store) {
  if (!isDependencyClosure(closure)) fail('verifyClosureAgainstStore expects a resolved closure', { got: typeof closure });
  requireStore(store, 'verifyClosureAgainstStore');
  const missing = [];
  const present = [];
  for (const identity of closure.order) {
    const name = identity.slice(0, identity.lastIndexOf('@'));
    const digest = closure.packages[name].digest;
    const address = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
    if (Object.hasOwn(store.addresses, address)) present.push(identity);
    else missing.push({ identity, address });
  }
  return deepFreeze({
    ok: missing.length === 0,
    reason: missing.length === 0 ? null : 'closure.store',
    present,
    missing,
    message: missing.length === 0 ? null : `${missing.length} of ${closure.order.length} packages are not in the store`,
  });
}

export const DEPENDENCY_CLOSURE_INPUT_SCHEMA_VERSION = NODE_REGISTRY_SCHEMA_VERSION;
