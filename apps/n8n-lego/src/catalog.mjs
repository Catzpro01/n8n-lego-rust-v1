/**
 * Node catalog.
 *
 * The real n8n editor renders the node palette and the parameter panel from the
 * node type descriptions that n8n publishes as static JSON:
 *
 *   <base>/rest/types/nodes.json          -> INodeTypeDescription[]
 *   <base>/rest/types/node-versions.json  -> "name@version"[]
 *
 * n8n lego serves the same files, taken verbatim from the pinned n8n release
 * (`n8n-nodes-base@2.9.1`, extracted by `scripts/fetch-n8n-catalog.mjs`). That
 * keeps the editor faithful without pulling the whole 70 MB node package or its
 * dependency tree into the runtime: the catalog is metadata only, execution
 * stays with the LEGO engine.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CATALOG_NODES_FILE = 'nodes.json';
export const CATALOG_CREDENTIALS_FILE = 'credentials.json';

let cache = null;

export function catalogPaths(config) {
  return {
    dir: config.catalogDir,
    nodes: join(config.catalogDir, CATALOG_NODES_FILE),
    credentials: join(config.catalogDir, CATALOG_CREDENTIALS_FILE),
  };
}

export function catalogPresent(config) {
  const paths = catalogPaths(config);
  return existsSync(paths.nodes);
}

/** Loads the catalog once per process. Returns `null` when it has not been fetched yet. */
export function loadCatalog(config) {
  if (cache) return cache;
  const paths = catalogPaths(config);
  if (!existsSync(paths.nodes)) return null;

  const nodes = JSON.parse(readFileSync(paths.nodes, 'utf8'));
  const credentials = existsSync(paths.credentials) ? JSON.parse(readFileSync(paths.credentials, 'utf8')) : [];
  const byName = new Map();
  for (const node of nodes) {
    const key = node.name;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(node);
  }

  cache = {
    dir: paths.dir,
    nodes,
    credentials,
    byName,
    /** "n8n-nodes-base.set@3.4" style identifiers, newest version first within a name. */
    versions: nodes.map((node) => `${node.name}@${node.version}`),
    raw: { nodes: () => readFileSync(paths.nodes), credentials: () => readFileSync(paths.credentials) },
  };
  return cache;
}

export function resetCatalogCache() {
  cache = null;
}

/**
 * Search used by the editor's node-creation panel (`POST /rest/node-types`).
 * Mirrors the reference filter semantics: a node matches when the query appears
 * in its name, display name, description, or one of its categories.
 */
export function searchNodeTypes(catalog, { query = '', limit = 50, onlyLatest = true } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const seen = new Set();
  const out = [];
  for (const node of catalog.nodes) {
    if (onlyLatest && !isLatestVersion(node) ) continue;
    if (onlyLatest && seen.has(node.name)) continue;
    if (needle !== '') {
      const haystack = [node.name, node.displayName, node.description, ...(node.categories ?? []), ...(node.codex?.categories ?? [])]
        .filter((value) => typeof value === 'string')
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    seen.add(node.name);
    out.push(node);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A versioned node (`version: [1, 2, 4.1]` + `defaultVersion`) is "latest" when
 * the requested/default version is one it serves; a plain node is latest when it
 * is the only entry for that name.
 */
export function isLatestVersion(node) {
  if (Array.isArray(node.version)) return node.version.includes(node.defaultVersion);
  return node.defaultVersion === undefined || node.defaultVersion === node.version;
}

/**
 * Resolves a node description the way n8n's `NodeTypes.getDescriptionWithTranslation`
 * does: exact version first, then any entry that serves the requested version,
 * then the newest available entry.
 */
export function findNodeType(catalog, name, version) {
  const versions = catalog.byName.get(name);
  if (!versions || versions.length === 0) return null;
  if (version === undefined || version === null) {
    return versions.find((node) => isLatestVersion(node)) ?? versions[0];
  }
  const requested = Number(version);
  const exact = versions.find((node) => Number(node.version) === requested);
  if (exact) return exact;
  const serving = versions.find((node) => Array.isArray(node.version) && node.version.map(Number).includes(requested));
  if (serving) return serving;
  const indexed = versions.find((node) => {
    const list = Array.isArray(node.version) ? node.version.map(Number) : [Number(node.version)];
    return list.some((candidate) => candidate <= requested);
  });
  return indexed ?? versions.find((node) => isLatestVersion(node)) ?? versions[0];
}
