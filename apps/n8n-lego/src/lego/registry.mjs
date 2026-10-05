/**
 * Backend LEGO foundation — the domain/capability registry.
 *
 * PUBLIC CONTRACT (`lego.domain-registry`, v1.0.0, owner: manager).
 *
 * This module is the programmatic face of `manifest/domains.json`: the single
 * source of truth for which backend domains exist, who owns them, which files
 * they own, what they may depend on, and which capabilities they declare.
 *
 * It is deliberately data-first and dependency-free:
 *   - no domain may be imported from here (it must stay a graph leaf),
 *   - no I/O beyond reading its own manifest,
 *   - no framework — the smallest structure that lets both humans and the
 *     architecture gate (`tools/lego/architecture-gate.mjs`) answer
 *     "is this import allowed?".
 *
 * It describes boundaries. It does not implement any domain.
 *
 * P2.7 adds hierarchy: an entry may declare `parent`, making it a sub-LEGO.
 * A sub-LEGO is a full registry entry — same ownership, contract, versioning
 * and dependency rules — so every mechanism works identically at every level
 * (`children`, `descendants`, `ancestors`, `lineage`, `nestingDepth`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, 'manifest', 'domains.json');
const ERRORS_CONTRACT_PATH = resolve(HERE, 'contracts', 'errors.contract.json');
const CONTRACT_LOCK_PATH = resolve(HERE, 'contracts', 'contract-lock.json');

/**
 * Implementation-status vocabulary a domain/capability may declare.
 *
 * `contract-only` (P2.10) is deliberately distinct from `planned`:
 *
 *   planned        we intend to build this; no contract is fixed yet
 *   contract-only  the CONTRACT is fixed and testable; no implementation exists
 *
 * The distinction matters because the two make different promises. A
 * `contract-only` capability can be gate-checked, negotiated against and
 * implemented by a third party without further design; a `planned` one cannot.
 * Collapsing them would either overstate `planned` or understate the AI
 * Foundation contracts, and a consumer could not tell which it was looking at.
 */
export const DOMAIN_STATUS = Object.freeze([
  'implemented',
  'partial',
  'planned',
  'contract-only',
  'legacy',
  'unsupported',
  'deferred',
  'template',
]);

/** Structural role of a registry entry. */
export const DOMAIN_KINDS = Object.freeze([
  'domain',
  'kernel',
  'boundary',
  'legacy',
  'composition-root',
  'governance',
  'template',
]);

export const MANIFEST_FILE = MANIFEST_PATH;
export const ERRORS_CONTRACT_FILE = ERRORS_CONTRACT_PATH;
export const CONTRACT_LOCK_FILE = CONTRACT_LOCK_PATH;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// @scale-out-safe: immutable memoization of three static JSON files that ship
// with the package. Every process computes an identical value, nothing mutates
// the cached object (it is frozen), and `reload` exists for tests. No shared
// state crosses a process boundary.
let cached = null;

/**
 * Loads (and caches) the backend LEGO registry.
 * @param {{ reload?: boolean }} [options]
 */
export function loadRegistry({ reload = false } = {}) {
  if (cached && !reload) return cached;
  const manifest = readJson(MANIFEST_PATH);
  const errorContract = readJson(ERRORS_CONTRACT_PATH);
  const contractLock = readJson(CONTRACT_LOCK_PATH);
  const byId = new Map(manifest.domains.map((domain) => [domain.id, domain]));
  cached = Object.freeze({
    manifest,
    errorContract,
    contractLock,
    domains: manifest.domains,
    agents: manifest.agents,
    allowances: manifest.allowances ?? [],
    legacy: manifest.legacy ?? { files: [] },
    // Surface aliases (P2.10): external/UI vocabulary -> canonical domain id.
    // Exposed so the gate can prove the mapping is total and unambiguous
    // rather than leaving each consumer to guess that "executions" means
    // `execution`.
    surfaceAliases: manifest.surfaceAliases ?? { aliases: [] },
    byId,
  });
  return cached;
}

/** @returns {object|undefined} */
export function getDomain(id, registry = loadRegistry()) {
  return registry.byId.get(id);
}

/* ------------------------------------------------------------ nesting (P2.7) */

/** Maximum parent -> child -> grandchild depth the registry permits. */
export const MAX_NESTING_DEPTH = 3;

/** Direct children of a LEGO, in declaration order. */
export function getChildren(id, registry = loadRegistry()) {
  return registry.domains.filter((domain) => domain.parent === id);
}

/** Every descendant, depth-first. */
export function getDescendants(id, registry = loadRegistry()) {
  const out = [];
  for (const child of getChildren(id, registry)) {
    out.push(child, ...getDescendants(child.id, registry));
  }
  return out;
}

/** Ancestors from the immediate parent up to the root. */
export function getAncestors(id, registry = loadRegistry()) {
  const out = [];
  let current = getDomain(id, registry);
  const guard = new Set([id]);
  while (current?.parent) {
    const parent = getDomain(current.parent, registry);
    if (!parent || guard.has(parent.id)) break; // malformed; validateRegistry reports it
    guard.add(parent.id);
    out.push(parent);
    current = parent;
  }
  return out;
}

/**
 * The chain from root to `id`, e.g.
 * `['reference-lego', 'reference-lego.validation', 'reference-lego.validation.schema']`.
 *
 * Ids are dotted by convention (`parent.child`), which keeps them readable, but
 * the hierarchy is defined by the `parent` field — never by parsing the id.
 */
export function lineage(id, registry = loadRegistry()) {
  return [...getAncestors(id, registry).map((domain) => domain.id).reverse(), id];
}

/** 1 for a root LEGO, 2 for a child, 3 for a grandchild. */
export function nestingDepth(id, registry = loadRegistry()) {
  return getAncestors(id, registry).length + 1;
}

/** The root LEGO an entry ultimately belongs to. */
export function rootOf(id, registry = loadRegistry()) {
  const ancestors = getAncestors(id, registry);
  return ancestors.length > 0 ? ancestors[ancestors.length - 1] : getDomain(id, registry);
}

/** True when `maybeAncestorId` is `id` itself or any ancestor of it. */
export function isWithin(id, maybeAncestorId, registry = loadRegistry()) {
  if (id === maybeAncestorId) return true;
  return getAncestors(id, registry).some((domain) => domain.id === maybeAncestorId);
}

/** The whole tree as nested nodes, for reports and docs. */
export function tree(registry = loadRegistry()) {
  const build = (domain) => ({
    id: domain.id,
    owner: domain.owner,
    kind: domain.kind,
    status: domain.status,
    version: domain.contract?.version ?? null,
    children: getChildren(domain.id, registry).map(build),
  });
  return registry.domains.filter((domain) => !domain.parent).map(build);
}

/**
 * Resolves a repo-relative-to-app path (e.g. `src/compat/error.mjs`) to the
 * domain that owns it — longest declared path wins, so `src/auth/routes.mjs`
 * resolves to `auth` even though `src/auth.mjs` is also declared.
 */
export function domainForPath(relativePath, registry = loadRegistry()) {
  const normalized = relativePath.split(sep).join('/').replace(/^\.\//, '');
  let best = null;
  for (const domain of registry.domains) {
    for (const owned of domain.paths ?? []) {
      const isFile = owned.endsWith('.mjs') || owned.endsWith('.json');
      const matches = isFile ? normalized === owned : normalized === owned || normalized.startsWith(`${owned}/`);
      if (!matches) continue;
      if (!best || owned.length > best.length) best = { length: owned.length, domain, owned };
    }
  }
  return best ? best.domain : null;
}

/** True when `filePath` sits inside the declared PUBLIC surface of its domain. */
export function isPublicPath(relativePath, domain) {
  const normalized = relativePath.split(sep).join('/');
  return (domain.public ?? []).some((pub) => {
    const isFile = pub.endsWith('.mjs') || pub.endsWith('.json');
    return isFile ? normalized === pub : normalized === pub || normalized.startsWith(`${pub}/`);
  });
}

/**
 * The dependency-direction rule, in one function.
 *
 * @returns {{ allowed: boolean, reason: string, rule: string }}
 */
export function isDependencyAllowed(fromId, toId, registry = loadRegistry()) {
  if (fromId === toId) return { allowed: true, reason: 'same domain', rule: 'self' };
  const from = getDomain(fromId, registry);
  const to = getDomain(toId, registry);
  if (!from) return { allowed: false, reason: `unknown domain '${fromId}'`, rule: 'unknown-domain' };
  if (!to) return { allowed: false, reason: `unknown domain '${toId}'`, rule: 'unknown-domain' };

  // An explicit prohibition always wins, at any level of the hierarchy: it is
  // the one statement an owner makes that nothing else may override.
  if ((from.mustNotDependOn ?? []).includes(toId)) {
    return { allowed: false, reason: `'${fromId}' explicitly must not depend on '${toId}'`, rule: 'forbidden-direction' };
  }
  // An ancestor's prohibition binds its descendants — otherwise a domain could
  // evade its own rule by pushing the import down into a sub-LEGO.
  for (const ancestor of getAncestors(fromId, registry)) {
    if ((ancestor.mustNotDependOn ?? []).includes(toId) && !isWithin(toId, ancestor.id, registry)) {
      return {
        allowed: false,
        reason: `'${ancestor.id}' (ancestor of '${fromId}') must not depend on '${toId}'; a sub-LEGO cannot escape its parent's prohibition`,
        rule: 'forbidden-direction',
      };
    }
  }

  // Composition inside one LEGO: a parent may use its own descendants' public
  // contracts, and a sub-LEGO may use its parent's, without a dependsOn entry.
  // Reaching *internals* is still blocked — that is rule R4 in the gate, which
  // is evaluated independently of this direction check.
  if (isWithin(toId, fromId, registry)) {
    return { allowed: true, reason: `'${toId}' is a sub-LEGO of '${fromId}'`, rule: 'parent-child' };
  }
  if (isWithin(fromId, toId, registry)) {
    return { allowed: true, reason: `'${fromId}' is a sub-LEGO of '${toId}'`, rule: 'child-parent' };
  }

  if ((from.dependsOn ?? []).includes(toId)) {
    return { allowed: true, reason: 'declared dependency', rule: 'declared' };
  }

  // A declared dependency on a parent does NOT grant access to its children:
  // each sub-LEGO contract is consumed explicitly, or the hierarchy would leak.
  const targetRoot = rootOf(toId, registry);
  if (targetRoot && targetRoot.id !== toId && (from.dependsOn ?? []).includes(targetRoot.id)) {
    return {
      allowed: false,
      reason: `'${fromId}' depends on '${targetRoot.id}' but not on its sub-LEGO '${toId}' — declare the sub-LEGO contract explicitly`,
      rule: 'undeclared-dependency',
    };
  }

  return { allowed: false, reason: `'${fromId}' does not declare a dependency on '${toId}'`, rule: 'undeclared-dependency' };
}

/** Flat list of every declared capability with its domain and owner. */
export function listCapabilities(registry = loadRegistry()) {
  const out = [];
  for (const domain of registry.domains) {
    for (const capability of domain.capabilities ?? []) {
      out.push({
        id: capability.id,
        status: capability.status,
        domain: domain.id,
        owner: domain.owner,
        phase: capability.phase ?? domain.phase,
        contractVersion: domain.contract?.version ?? null,
      });
    }
  }
  return out;
}

export function getCapability(id, registry = loadRegistry()) {
  return listCapabilities(registry).find((capability) => capability.id === id) ?? null;
}

/**
 * Structural validation of the registry itself — every rule that can be checked
 * without touching source files. The architecture gate adds the source-level
 * checks on top.
 *
 * @returns {string[]} violations; empty means valid
 */
export function validateRegistry(registry = loadRegistry()) {
  const errors = [];
  const ids = new Set();
  const namespaces = new Map();
  const capabilityIds = new Map();
  const ownedPaths = new Map();
  const agentIds = new Set(Object.keys(registry.agents ?? {}));

  for (const domain of registry.domains) {
    const where = `domain '${domain.id}'`;
    if (ids.has(domain.id)) errors.push(`duplicate domain id '${domain.id}'`);
    ids.add(domain.id);

    if (!domain.owner) errors.push(`${where}: missing owner`);
    else if (!agentIds.has(domain.owner)) errors.push(`${where}: owner '${domain.owner}' is not a declared agent`);
    if (!DOMAIN_KINDS.includes(domain.kind)) errors.push(`${where}: unknown kind '${domain.kind}'`);
    if (!DOMAIN_STATUS.includes(domain.status)) errors.push(`${where}: unknown status '${domain.status}'`);
    if (!domain.contract || typeof domain.contract.version !== 'string') {
      errors.push(`${where}: missing contract.version`);
    }

    if (!domain.errorNamespace) errors.push(`${where}: missing errorNamespace`);
    else if (namespaces.has(domain.errorNamespace)) {
      errors.push(`${where}: errorNamespace '${domain.errorNamespace}' already used by '${namespaces.get(domain.errorNamespace)}'`);
    } else namespaces.set(domain.errorNamespace, domain.id);

    for (const owned of domain.paths ?? []) {
      if (ownedPaths.has(owned)) {
        errors.push(`path '${owned}' is claimed by both '${ownedPaths.get(owned)}' and '${domain.id}' — two agents cannot own the same code`);
      } else ownedPaths.set(owned, domain.id);
    }

    for (const pub of domain.public ?? []) {
      const inside = (domain.paths ?? []).some((owned) => pub === owned || pub.startsWith(`${owned}/`) || owned.startsWith(`${pub}/`));
      if (!inside) errors.push(`${where}: public surface '${pub}' is outside the domain's own paths`);
    }

    for (const dep of domain.dependsOn ?? []) {
      if (!registry.byId.has(dep)) errors.push(`${where}: dependsOn unknown domain '${dep}'`);
      if ((domain.mustNotDependOn ?? []).includes(dep)) {
        errors.push(`${where}: '${dep}' is in both dependsOn and mustNotDependOn`);
      }
    }
    for (const dep of domain.mustNotDependOn ?? []) {
      if (!registry.byId.has(dep)) errors.push(`${where}: mustNotDependOn unknown domain '${dep}'`);
    }

    // --- nesting (P2.7) ---
    if (domain.parent !== undefined) {
      const parent = registry.byId.get(domain.parent);
      if (!parent) {
        errors.push(`${where}: parent '${domain.parent}' is not a registered LEGO`);
      } else {
        if (domain.parent === domain.id) errors.push(`${where}: cannot be its own parent`);
        // A child's code must live inside its parent's code.
        for (const owned of domain.paths ?? []) {
          const inside = (parent.paths ?? []).some((parentPath) => owned === parentPath || owned.startsWith(`${parentPath}/`));
          if (!inside) {
            errors.push(`${where}: path '${owned}' is outside its parent '${parent.id}' — a sub-LEGO cannot own code its parent does not`);
          }
        }
        // A child must not be forbidden from its own parent, and vice versa.
        if ((domain.mustNotDependOn ?? []).includes(parent.id)) {
          errors.push(`${where}: cannot declare its own parent '${parent.id}' as forbidden`);
        }
      }
    }

    for (const capability of domain.capabilities ?? []) {
      if (capabilityIds.has(capability.id)) {
        errors.push(`capability '${capability.id}' declared by both '${capabilityIds.get(capability.id)}' and '${domain.id}'`);
      } else capabilityIds.set(capability.id, domain.id);
      if (!DOMAIN_STATUS.includes(capability.status)) {
        errors.push(`${where}: capability '${capability.id}' has unknown status '${capability.status}'`);
      }
    }
  }

  // Two agents must never silently own the same domain.
  const claimed = new Map();
  for (const [agentId, agent] of Object.entries(registry.agents ?? {})) {
    for (const domainId of agent.domains ?? []) {
      if (claimed.has(domainId)) {
        errors.push(`domain '${domainId}' is claimed by both '${claimed.get(domainId)}' and '${agentId}'`);
      } else claimed.set(domainId, agentId);
      if (!registry.byId.has(domainId)) errors.push(`agent '${agentId}' claims unknown domain '${domainId}'`);
    }
  }
  for (const domain of registry.domains) {
    if (claimed.get(domain.id) !== domain.owner) {
      errors.push(`ownership mismatch for '${domain.id}': domain.owner='${domain.owner}', agents map says '${claimed.get(domain.id) ?? 'nobody'}'`);
    }
  }

  // Parent/child hierarchy must be a forest of bounded depth, not a graph.
  for (const domain of registry.domains) {
    const seen = new Set([domain.id]);
    let current = domain;
    let depth = 1;
    while (current?.parent) {
      if (seen.has(current.parent)) {
        errors.push(`parent cycle involving '${domain.id}' -> '${current.parent}'`);
        break;
      }
      seen.add(current.parent);
      current = registry.byId.get(current.parent);
      if (!current) break;
      depth += 1;
    }
    if (depth > MAX_NESTING_DEPTH) {
      errors.push(
        `'${domain.id}' nests ${depth} levels deep; the limit is ${MAX_NESTING_DEPTH} (parent -> child -> grandchild). Deeper hierarchies are decorative, not structural.`,
      );
    }
  }

  // A sub-LEGO's owner must be a declared agent, and the agents map must claim
  // it exactly like a root LEGO — ownership is single-writer at every level.

  // Dependency cycles between domains are rejected outright.
  for (const cycle of findCycles(registry)) {
    errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  }

  // Error codes must belong to a declared namespace.
  const knownNamespaces = new Set([...namespaces.keys(), 'compat']);
  for (const entry of registry.errorContract.codes ?? []) {
    const namespace = entry.code.includes('.') ? entry.code.split('.')[0] : entry.code;
    if (entry.code === 'unsupported') continue;
    if (!knownNamespaces.has(namespace)) {
      errors.push(`error code '${entry.code}' uses namespace '${namespace}' which no domain declares`);
    }
  }

  // Every allowance must reference real domains and carry an owner + deadline.
  for (const allowance of registry.allowances ?? []) {
    const where = `allowance '${allowance.id}'`;
    if (!registry.byId.has(allowance.from)) errors.push(`${where}: unknown from-domain '${allowance.from}'`);
    if (!registry.byId.has(allowance.to)) errors.push(`${where}: unknown to-domain '${allowance.to}'`);
    if (!allowance.resolutionOwner) errors.push(`${where}: missing resolutionOwner`);
    if (!allowance.resolveBy) errors.push(`${where}: missing resolveBy`);
    if (!allowance.reason) errors.push(`${where}: missing reason`);
  }

  // Contract lock rows must point at real domains and declare tests.
  for (const contract of registry.contractLock.contracts ?? []) {
    const where = `contract '${contract.id}'`;
    if (!registry.byId.has(contract.domain)) errors.push(`${where}: unknown domain '${contract.domain}'`);
    if (!/^\d+\.\d+\.\d+$/.test(contract.version ?? '')) errors.push(`${where}: version must be major.minor.patch`);
    if (!(contract.tests ?? []).length) errors.push(`${where}: a public contract must declare contract tests`);
  }

  return errors;
}

function findCycles(registry) {
  const cycles = [];
  const state = new Map();
  const stack = [];

  const visit = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 'open');
    stack.push(id);
    const domain = registry.byId.get(id);
    for (const dep of domain?.dependsOn ?? []) {
      if (registry.byId.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, 'done');
  };

  for (const domain of registry.domains) {
    // The composition root legitimately depends on everything; it is a sink,
    // nothing imports it back, so it cannot create a real cycle.
    if (domain.compositionRoot) continue;
    visit(domain.id);
  }
  return cycles;
}
