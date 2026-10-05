/**
 * Compatibility layer — the permission model behind `PublicUser.globalScopes`.
 *
 * Part of the n8n compatibility boundary (`src/compat/`): capability/scope
 * exposure. The role → scope map is **extracted from the pinned n8n source**
 * (`@n8n/permissions/src/roles/**`, via `scripts/fetch-n8n-roles.mjs`) and ships
 * as `data/roles.json`. Nothing here invents scopes: `getGlobalScopes` mirrors
 * upstream `getGlobalScopes()` in
 * `cli/src/services/user.service.ts` — the scopes of the user's global role, or
 * `[]` when the role is unknown. It deliberately never returns "all scopes" and
 * never bypasses RBAC.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT } from '../config.mjs';

/**
 * Role → scope map, extracted from the pinned n8n source by
 * `scripts/fetch-n8n-roles.mjs`. Falls back to a minimal owner role so the editor
 * still renders when the extraction has not been run.
 */
let rolesCache = null;

export function loadRoles(config) {
  if (rolesCache) return rolesCache;
  // The extracted copy (per install) wins; the package ships the same file so a
  // fresh `npm install -g` renders the editor correctly even before any fetch.
  const candidates = [join(config.catalogDir, 'roles.json'), join(APP_ROOT, 'data', 'roles.json')];
  for (const file of candidates) {
    if (existsSync(file)) {
      rolesCache = JSON.parse(readFileSync(file, 'utf8'));
      return rolesCache;
    }
  }
  const owner = {
    slug: 'global:owner',
    displayName: 'Owner',
    description: 'Owner',
    // Last-resort fallback only: a minimal subset so a missing roles.json never
    // silently grants capabilities the extraction did not prove.
    scopes: ['workflow:create', 'workflow:read', 'workflow:update', 'workflow:delete', 'workflow:list', 'credential:create', 'credential:read', 'credential:update', 'credential:delete', 'credential:list', 'user:read', 'user:list', 'user:create', 'user:changeRole', 'execution:read', 'execution:list', 'tag:create', 'tag:read', 'tag:update', 'tag:delete', 'project:create', 'project:read', 'project:update', 'project:delete', 'project:list'],
    licensed: false,
    systemRole: true,
    roleType: 'global',
  };
  rolesCache = { global: [owner], project: [], credential: [], workflow: [] };
  return rolesCache;
}

/** Test hook: the cached map is process-global, so contract tests reset it. */
export function resetRolesCache() {
  rolesCache = null;
}

/**
 * The global scopes a user actually holds: the scopes of their global role,
 * exactly like upstream `getGlobalScopes(principal)` (the role entity's scopes,
 * `[]` when the role is unknown). The value is computed per lookup from the
 * extracted permission model — never hardcoded, never "all scopes".
 *
 * @param {{ role?: string } | null} user stored user record
 * @param {object} config runtime config (locates roles.json)
 * @returns {string[]} scope slugs, e.g. `['workflow:create', …]`
 */
export function getGlobalScopes(user, config) {
  if (!user) return [];
  const slug = user.role ?? 'global:owner';
  const roles = loadRoles(config);
  const role = (roles.global ?? []).find((candidate) => candidate.slug === slug);
  return Array.isArray(role?.scopes) ? [...role.scopes] : [];
}
