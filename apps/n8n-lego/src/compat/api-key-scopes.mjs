/**
 * Compatibility layer — the API-key scope vocabulary (P5.7).
 *
 * Extracted from the pinned `@n8n/permissions` source by
 * `scripts/fetch-n8n-roles.mjs` (next to roles.json) and shipped as
 * `data/api-key-scopes.json`. Nothing here invents a scope.
 *
 * Upstream keeps API-key scopes apart from role scopes: `ApiKeyScope` is its
 * own vocabulary (`API_KEY_RESOURCES`), and sixteen of its fifty-three entries
 * (`execution:read`, `workflow:activate`, `dataTableRow:upsert`, …) belong to no
 * role. A key principal is therefore authorized against THIS universe, never
 * the role universe — otherwise the P5.3 unknown-permission rule would refuse
 * scopes the editor legitimately offers.
 *
 * `apiKeyScopesForRole` mirrors upstream `getApiKeyScopesForRole(user)`:
 * the role's own scopes plus the implicit personal-project scopes, filtered to
 * the API-key vocabulary, de-duplicated; `[]` for the roles upstream
 * short-circuits (`global:chatUser`) and for an unknown role.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_ROOT } from '../config.mjs';
import { loadRoles } from './scopes.mjs';

// @scale-out-safe: immutable memo of a static file that ships with the package (extracted from the pinned n8n source); every process reads the same bytes, so two workers cannot diverge.
let cache = null;

/**
 * @param {object} config runtime config (locates the extracted file)
 * @returns {Readonly<{ resources: object, all: readonly string[], implicitPersonalProject: readonly string[], noKeyRoles: readonly string[] }>}
 */
export function loadApiKeyScopes(config) {
  if (cache) return cache;
  const candidates = [join(config.catalogDir ?? '', 'api-key-scopes.json'), join(APP_ROOT, 'data', 'api-key-scopes.json')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed.all) || parsed.all.length === 0) continue;
    cache = Object.freeze({
      resources: Object.freeze({ ...parsed.resources }),
      all: Object.freeze([...parsed.all]),
      implicitPersonalProject: Object.freeze([...(parsed.implicitPersonalProject ?? [])]),
      noKeyRoles: Object.freeze([...(parsed.noKeyRoles ?? [])]),
    });
    return cache;
  }
  // Fail closed: no extracted vocabulary means no key can be granted any scope.
  cache = Object.freeze({ resources: Object.freeze({}), all: Object.freeze([]), implicitPersonalProject: Object.freeze([]), noKeyRoles: Object.freeze([]) });
  return cache;
}

/** Test hook: the cached vocabulary is process-global. */
export function resetApiKeyScopesCache() {
  cache = null;
}

/**
 * The API-key scopes a global role may place on a key (upstream
 * `getApiKeyScopesForRole`). Computed per call from the extracted models.
 *
 * @param {string} roleSlug e.g. `global:member`
 * @param {object} config
 * @returns {string[]}
 */
export function apiKeyScopesForRole(roleSlug, config) {
  const vocabulary = loadApiKeyScopes(config);
  if (vocabulary.noKeyRoles.includes(roleSlug)) return [];
  const role = (loadRoles(config).global ?? []).find((candidate) => candidate.slug === roleSlug);
  if (!role) return [];
  const universe = new Set(vocabulary.all);
  return [...new Set([...(role.scopes ?? []), ...vocabulary.implicitPersonalProject])].filter((scope) => universe.has(scope));
}
