#!/usr/bin/env node
/**
 * Extracts the role → scope map from the pinned n8n source.
 *
 * The editor hides buttons based on scopes (`workflow:create`, `credential:share`,
 * …) that it reads from `GET /rest/roles`. Those scopes live in
 * `reference/n8n/packages/@n8n/permissions/src/roles/**` as plain string arrays,
 * so this script reads them instead of hard-coding a guess that would silently
 * drift from the UI's expectations.
 *
 *   node scripts/fetch-n8n-roles.mjs [--dir <output dir>]
 *
 * Output: <dir>/roles.json — shaped like `AllRolesMap` from `@n8n/permissions`;
 *         <dir>/api-key-scopes.json — the API-key scope vocabulary (P5.7).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultCatalogDir } from '../src/config.mjs';

/** apps/n8n-lego/scripts -> apps/n8n-lego */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The role definitions only exist in the reference checkout, not in an npm install. */
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const PERMISSIONS_SRC = join(REPO_ROOT, 'reference', 'n8n', 'packages', '@n8n', 'permissions', 'src');
const BUNDLED = join(PACKAGE_ROOT, 'data', 'roles.json');
const BUNDLED_API_KEY_SCOPES = join(PACKAGE_ROOT, 'data', 'api-key-scopes.json');

function parseArgs(argv) {
  const args = { dir: defaultCatalogDir() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = resolve(argv[++i]);
  }
  return args;
}

/**
 * `export const NAME: Scope[] = ['a', 'b'];` -> { NAME: ['a','b'] }
 * Aliases built from another array also resolve —
 * `export const X = Y.concat();` (e.g. GLOBAL_ADMIN_SCOPES = GLOBAL_OWNER_SCOPES.concat())
 * — because they name the *same* scope set and silently degrading them to []
 * would hide permissions the extraction is supposed to prove.
 */
function extractScopeArrays(source) {
  const out = {};
  const pattern = /export const ([A-Z_0-9]+)(?::\s*[^=]+)?\s*=\s*\[([\s\S]*?)\];/g;
  for (const match of source.matchAll(pattern)) {
    const [, name, body] = match;
    out[name] = [...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  }
  const concatPattern = /export const ([A-Z_0-9]+)(?::\s*[^=]+)?\s*=\s*([A-Z_0-9]+)\.concat\(([\s\S]*?)\);/g;
  let progress = true;
  for (let pass = 0; pass < 3 && progress; pass += 1) {
    progress = false;
    for (const match of source.matchAll(concatPattern)) {
      const [, name, base, extra] = match;
      if (out[name] || !out[base]) continue;
      const added = [...extra.matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
      out[name] = [...out[base], ...added];
      progress = true;
    }
  }
  return out;
}

/** `export const X_MAP: ... = { 'role': CONST, ... }` -> { role: CONST } */
function extractRoleMap(source, mapName) {
  const start = source.indexOf(`export const ${mapName}`);
  if (start === -1) throw new Error(`cannot find ${mapName} in role-maps.ee.ts`);
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  const map = {};
  for (const match of body.matchAll(/'([^']+)'\s*:\s*([A-Z_0-9]+)/g)) {
    map[match[1]] = match[2];
  }
  return map;
}

/** `'global:owner': 'Owner',` -> { 'global:owner': 'Owner' } */
function extractStringRecord(source, recordName) {
  const start = source.indexOf(`const ${recordName}`);
  if (start === -1) return {};
  const end = source.indexOf('};', start);
  const body = source.slice(start, end);
  const record = {};
  for (const match of body.matchAll(/\[?([A-Za-z_0-9.]+)\]?|'([^']+)'\s*:\s*'([^']*)'/g)) {
    /* handled below */
  }
  for (const match of body.matchAll(/'([^']+)'\s*:\s*'([^']*)'/g)) record[match[1]] = match[2];
  for (const match of body.matchAll(/\[([A-Z_0-9]+)\]\s*:\s*'([^']*)'/g)) record[match[1]] = match[2];
  return record;
}

function readConstants(source) {
  const constants = {};
  for (const match of source.matchAll(/export const ([A-Z_0-9]+)\s*=\s*'([^']+)'/g)) constants[match[1]] = match[2];
  return constants;
}

/**
 * P5.7 — the API-key scope vocabulary, from the same pinned source.
 *
 * Upstream keeps it apart from the role scopes: `ApiKeyScope` is built from
 * `API_KEY_RESOURCES` (constants.ee.ts, via `buildApiKeyScopes()`), and
 * `getApiKeyScopesForRole()` (public-api-permissions.ee.ts) grants a role its own
 * scopes plus `API_KEY_SCOPES_FOR_IMPLICIT_PERSONAL_PROJECT`, filtered to that
 * vocabulary, and nothing at all to the roles it short-circuits. Sixteen of the
 * fifty-three key scopes (`execution:read`, `workflow:activate`, …) exist in no
 * role, so this cannot be derived from roles.json — it is extracted, never typed.
 *
 * Fails loudly when the upstream shape moves: an empty or partial vocabulary
 * would silently deny (or worse, mis-grant) every key.
 */
function extractApiKeyScopes() {
  const constants = readFileSync(join(PERMISSIONS_SRC, 'constants.ee.ts'), 'utf8');
  const defaults = constants.match(/export const DEFAULT_OPERATIONS = \[([^\]]*)\]/);
  if (!defaults) throw new Error('cannot find DEFAULT_OPERATIONS in constants.ee.ts');
  const defaultOps = [...defaults[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const block = constants.match(/export const API_KEY_RESOURCES = \{([\s\S]*?)\n\} as const/);
  if (!block) throw new Error('cannot find API_KEY_RESOURCES in constants.ee.ts');
  const resources = {};
  for (const [, resource, body] of block[1].matchAll(/^\s*([A-Za-z]+):\s*\[([^\]]*)\]/gm)) {
    const ops = [];
    if (body.includes('...DEFAULT_OPERATIONS')) ops.push(...defaultOps);
    ops.push(...[...body.matchAll(/'([^']+)'/g)].map((m) => m[1]));
    resources[resource] = [...new Set(ops)];
  }
  const all = Object.entries(resources).flatMap(([resource, ops]) => ops.map((op) => `${resource}:${op}`));
  if (all.length === 0) throw new Error('API_KEY_RESOURCES produced no scopes');

  const publicApi = readFileSync(join(PERMISSIONS_SRC, 'public-api-permissions.ee.ts'), 'utf8');
  const arrays = extractScopeArrays(publicApi);
  const implicit = arrays.API_KEY_SCOPES_FOR_IMPLICIT_PERSONAL_PROJECT;
  if (!Array.isArray(implicit) || implicit.length === 0) {
    throw new Error('cannot find API_KEY_SCOPES_FOR_IMPLICIT_PERSONAL_PROJECT in public-api-permissions.ee.ts');
  }
  const fn = publicApi.slice(publicApi.indexOf('export const getApiKeyScopesForRole'));
  const noKeyRoles = [...fn.slice(0, fn.indexOf('\n};')).matchAll(/role\.slug === '([^']+)'\)\s*\{\s*return \[\];/g)].map((m) => m[1]);
  if (noKeyRoles.length === 0) throw new Error('cannot find the no-key role short-circuit in getApiKeyScopesForRole');
  const unknown = implicit.filter((scope) => !all.includes(scope));
  if (unknown.length) throw new Error(`implicit personal-project scopes outside the API-key vocabulary: ${unknown.join(', ')}`);
  return { resources, all, implicitPersonalProject: implicit, noKeyRoles };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scopesDir = join(PERMISSIONS_SRC, 'roles', 'scopes');
  if (!existsSync(scopesDir)) {
    // Global install: the reference checkout is not shipped, so fall back to the
    // roles.json generated from it (same file, kept in the package).
    if (existsSync(BUNDLED)) {
      mkdirSync(args.dir, { recursive: true });
      const target = join(args.dir, 'roles.json');
      copyFileSync(BUNDLED, target);
      if (existsSync(BUNDLED_API_KEY_SCOPES)) copyFileSync(BUNDLED_API_KEY_SCOPES, join(args.dir, 'api-key-scopes.json'));
      process.stdout.write(
        `reference source not found (${scopesDir}) — installed the bundled roles.json to ${target}\n`,
      );
      return;
    }
    process.stderr.write(`reference source not found: ${scopesDir}\n`);
    process.exit(1);
  }

  const scopes = {};
  for (const file of ['credential-sharing-scopes.ee.ts', 'global-scopes.ee.ts', 'project-scopes.ee.ts', 'workflow-sharing-scopes.ee.ts']) {
    Object.assign(scopes, extractScopeArrays(readFileSync(join(scopesDir, file), 'utf8')));
  }

  const roleMaps = readFileSync(join(PERMISSIONS_SRC, 'roles', 'role-maps.ee.ts'), 'utf8');
  const allRoles = readFileSync(join(PERMISSIONS_SRC, 'roles', 'all-roles.ts'), 'utf8');
  const constants = readConstants(readFileSync(join(PERMISSIONS_SRC, 'constants.ee.ts'), 'utf8'));
  const names = extractStringRecord(allRoles, 'ROLE_NAMES');
  const descriptions = extractStringRecord(allRoles, 'ROLE_DESCRIPTIONS');

  const resolveSlug = (value) => constants[value] ?? value;

  const maps = {
    global: extractRoleMap(roleMaps, 'GLOBAL_SCOPE_MAP'),
    project: extractRoleMap(roleMaps, 'PROJECT_SCOPE_MAP'),
    credential: extractRoleMap(roleMaps, 'CREDENTIALS_SHARING_SCOPE_MAP'),
    workflow: extractRoleMap(roleMaps, 'WORKFLOW_SHARING_SCOPE_MAP'),
  };

  const result = {};
  for (const [roleType, map] of Object.entries(maps)) {
    result[roleType] = Object.entries(map).map(([rawSlug, scopeConst]) => {
      const slug = resolveSlug(rawSlug);
      return {
        slug,
        displayName: names[rawSlug] ?? names[slug] ?? slug,
        description: descriptions[rawSlug] ?? descriptions[slug] ?? slug,
        scopes: scopes[scopeConst] ?? [],
        licensed: false,
        systemRole: true,
        roleType,
      };
    });
  }

  mkdirSync(args.dir, { recursive: true });
  const target = join(args.dir, 'roles.json');
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  const counts = Object.entries(result)
    .map(([type, roles]) => `${type}:${roles.length}`)
    .join(' ');
  const ownerScopes = result.global.find((role) => role.slug === 'global:owner')?.scopes.length ?? 0;
  process.stdout.write(`wrote ${target} (${counts}; global:owner has ${ownerScopes} scopes)\n`);

  const apiKeyScopes = extractApiKeyScopes();
  const apiKeyTarget = join(args.dir, 'api-key-scopes.json');
  writeFileSync(apiKeyTarget, `${JSON.stringify(apiKeyScopes, null, 2)}\n`);
  process.stdout.write(`wrote ${apiKeyTarget} (${apiKeyScopes.all.length} API-key scopes)\n`);
}

main();
