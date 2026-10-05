/**
 * P5.3 — Canonical permission registry: compiled numeric scope IDs.
 *
 * PUBLIC CONTRACT (`auth.authorization`, v1.0.0, owner: agent-1).
 *
 * WHY THIS EXISTS: the hot path compares permissions constantly. Comparing
 * strings is fine for ten scopes and wasteful for two hundred; a `Set<string>`
 * also allocates. So the canonical scope strings are compiled once into dense
 * integer ids, and the hot path compares integers.
 *
 * THE VOCABULARY IS NOT OURS TO INVENT. Every permission here is read out of the
 * extracted upstream permission model — `data/roles.json`, produced from the
 * pinned n8n source (`@n8n/permissions/src/roles/**`) by
 * `scripts/fetch-n8n-roles.mjs` and already consumed by `src/compat/scopes.mjs`.
 * This module adds **no** permission of its own. That is what "no second
 * authorization vocabulary" means in practice: the universe is derived, never
 * declared here.
 *
 * The second job is the P5.3 CRITICAL invariant:
 *
 * > `permissionUniverse` must come from the canonical permission universe so an
 * > unknown permission/scope fails closed.
 *
 * A typo'd grant like `workflow:reed` is the dangerous case: if it silently
 * matched nothing it would look like a harmless no-op, and a reviewer would see a
 * grant that clearly "should" work. The universe makes an unknown scope a
 * rejection rather than an inert string.
 */
import { loadRoles } from '../../compat/scopes.mjs';

/**
 * Builds a registry from the extracted role model.
 *
 * @param {object} roles parsed roles.json: { global, project, credential, workflow }
 * @returns {Readonly<object>}
 */
export function createPermissionRegistry(roles) {
  if (roles === null || typeof roles !== 'object') {
    throw new TypeError('permission registry requires the parsed role model');
  }
  const buckets = ['global', 'project', 'credential', 'workflow'];
  const collected = new Set();
  for (const bucket of buckets) {
    for (const role of roles[bucket] ?? []) {
      for (const scope of role?.scopes ?? []) {
        if (typeof scope === 'string' && scope !== '') collected.add(scope);
      }
    }
  }
  if (collected.size === 0) {
    throw new Error(
      'permission registry: the role model contains no scopes — refusing to build an empty universe, ' +
        'because an empty universe would make every permission unknown and deny everything',
    );
  }

  // Sorted for determinism: two deployments with the same roles.json must assign
  // the same ids, so a compiled id stays meaningful across processes and restarts.
  const permissions = [...collected].sort();
  const idToName = new Map();
  const nameToId = new Map();
  permissions.forEach((name, index) => {
    idToName.set(index, name);
    nameToId.set(name, index);
  });

  const universe = new Set(permissions);

  return Object.freeze({
    /** How many permissions the canonical model publishes. */
    size: permissions.length,
    /** Sorted canonical permission names. */
    permissions: Object.freeze(permissions),
    /** Every canonical permission — what `permissionUniverse` needs. */
    universe: Object.freeze(universe),

    /**
     * Resolves a permission to its compiled id, or `null` when unknown.
     * Unknown is reported, never defaulted — the caller decides to DENY.
     */
    idOf(name) {
      if (typeof name !== 'string') return null;
      return nameToId.has(name) ? nameToId.get(name) : null;
    },

    /** Resolves a compiled id back to its canonical name. */
    nameOf(id) {
      return Number.isInteger(id) ? idToName.get(id) ?? null : null;
    },

    /** Is this permission part of the canonical vocabulary? */
    has(name) {
      return typeof name === 'string' && universe.has(name);
    },

    /**
     * Compiles a permission list into a sorted, deduplicated id array.
     * Unknown permissions are reported separately so the caller fails closed
     * instead of silently dropping them.
     *
     * @returns {{ ids: number[], unknown: string[] }}
     */
    compile(names) {
      const ids = new Set();
      const unknown = [];
      for (const name of names ?? []) {
        const id = nameToId.get(name);
        if (id === undefined) unknown.push(String(name));
        else ids.add(id);
      }
      return { ids: [...ids].sort((a, b) => a - b), unknown };
    },
  });
}

/**
 * Builds the registry from runtime config by loading the extracted role model.
 * Delegates to `compat/scopes.mjs` so there is exactly one loader, one cache and
 * one source of truth for what a scope is.
 *
 * Memoised per roles-model identity: compiling ~180 permissions is cheap but not
 * free, and the role model only changes if roles.json is replaced.
 *
 * @param {object} config runtime config
 * @returns {Readonly<object>}
 */
const REGISTRY_CACHE = new WeakMap();

export function permissionRegistryFor(config) {
  const roles = loadRoles(config);
  if (typeof roles !== 'object' || roles === null) {
    throw new Error('permission registry: the role model did not load');
  }
  const cached = REGISTRY_CACHE.get(roles);
  if (cached) return cached;
  const registry = createPermissionRegistry(roles);
  REGISTRY_CACHE.set(roles, registry);
  return registry;
}

/** Test/upgrade hook: drop the memo for one role model. */
export function resetPermissionRegistryCacheFor(roles) {
  if (roles) REGISTRY_CACHE.delete(roles);
}
