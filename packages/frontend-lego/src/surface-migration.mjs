/**
 * Frontend surface migration inventory (Issue #241).
 *
 * A second *axis* on top of `manifest/surfaces.json` — not a second surface catalog.
 * Each entry points at declared surface ids and records where that UI region sits in
 * the strangler journey described by Issue #240:
 *
 *   reference-only → contract-ready → pilot-available → parity-pending → lego-primary
 *
 * This is **not** the capability runtime lifecycle (`lifecycle.mjs`: available…disabled)
 * and **not** the backend `capabilityMigrationState` (`stable | not-started |
 * strangler-pending`). Those answer different questions; this one answers:
 * "who owns this UI region today, and how would it move to Frontend LEGO safely?"
 *
 * Framework-neutral and browser-safe: no framework import, no `node:*` import.
 * Manifest bytes are supplied by the caller (or loaded once via manifests.mjs in Node).
 */

/** Closed migration vocabulary for UI surfaces (Issue #240 strangler model). */
export const MIGRATION_STATUSES = Object.freeze([
  'reference-only',
  'contract-ready',
  'pilot-available',
  'parity-pending',
  'lego-primary',
]);

/** Contract readiness of the surface migration contract (not the HTTP status model). */
export const MIGRATION_CONTRACT_STATUSES = Object.freeze(['declared', 'consuming', 'ready', 'verified']);

/** How a surface rolls back if the LEGO path is wrong. */
export const ROLLBACK_STRATEGIES = Object.freeze([
  'reference-remains-default',
  'pilot-not-primary',
  'lego-primary-with-reference',
]);

/** Required category coverage for a complete inventory (Issue #241 §Scope A). */
export const REQUIRED_CATEGORIES = Object.freeze([
  'application-shell-navigation',
  'workflow-list-dashboard',
  'workflow-editor',
  'canvas',
  'node-picker-catalog',
  'node-parameter-ndv',
  'execution-history',
  'credentials-settings',
  'projects-workspace',
  'import-export',
  'ai-surfaces',
  'localization',
  'loading-error-empty-primitives',
  'accessibility-shared-primitives',
]);

/** Fields every inventory entry must carry (shape, not content). */
export const ENTRY_FIELDS = Object.freeze([
  'inventoryId',
  'category',
  'title',
  'surfaceIds',
  'currentOwner',
  'proposedLegoOwner',
  'migrationStatus',
  'referenceImplementation',
  'contractStatus',
  'evidencePath',
  'rollbackStrategy',
  'dependencies',
  'notes',
]);

/**
 * Fields an entry MAY carry but need not. `sourceIssue` is here rather than in
 * `ENTRY_FIELDS` because it is only meaningful on a migrated surface: requiring it
 * on a `reference-only` entry would be noise. It IS required on a pilot-available
 * entry, because the single-pilot rule is per slice and "per slice" is
 * unenforceable if nothing records the slice.
 */
export const ENTRY_OPTIONAL_FIELDS = Object.freeze(['sourceIssue']);

export class SurfaceMigrationError extends Error {
  constructor(message, { inventoryId = null, errors = [] } = {}) {
    super(message);
    this.name = 'SurfaceMigrationError';
    this.code = 'frontend.surface-migration.invalid';
    this.inventoryId = inventoryId;
    this.errors = Object.freeze([...errors]);
  }
}

const INVENTORY_ID_PATTERN = /^ui\.[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Validate one inventory entry against the declared surface catalog.
 *
 * @param {object} entry
 * @param {{ surfaceIds: Set<string>, knownCategories?: Set<string>, knownStatuses?: Set<string>,
 *           knownContractStatuses?: Set<string>, knownRollbacks?: Set<string>,
 *           knownEntries?: Set<string>, knownNamespaces?: Set<string> }} catalog
 * @returns {string[]} errors (empty when valid)
 */
export function validateMigrationEntry(entry, catalog = {}) {
  const errors = [];
  const surfaceIds = catalog.surfaceIds ?? new Set();
  const categories = catalog.knownCategories ?? null;
  const statuses = catalog.knownStatuses ?? new Set(MIGRATION_STATUSES);
  const contractStatuses = catalog.knownContractStatuses ?? new Set(MIGRATION_CONTRACT_STATUSES);
  const rollbacks = catalog.knownRollbacks ?? new Set(ROLLBACK_STRATEGIES);
  const knownEntries = catalog.knownEntries ?? null;

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return ['entry must be an object'];
  }
  for (const field of ENTRY_FIELDS) {
    if (entry[field] === undefined) errors.push(`missing required field "${field}"`);
  }
  const known = new Set([...ENTRY_FIELDS, ...ENTRY_OPTIONAL_FIELDS]);
  for (const key of Object.keys(entry)) {
    if (!known.has(key)) errors.push(`unknown field "${key}"`);
  }

  if (typeof entry.inventoryId !== 'string' || !INVENTORY_ID_PATTERN.test(entry.inventoryId)) {
    errors.push('"inventoryId" must look like "ui.area.name" (dot-separated kebab segments)');
  }
  if (typeof entry.category !== 'string' || entry.category.length === 0) {
    errors.push('"category" must be a non-empty string');
  } else if (categories && !categories.has(entry.category)) {
    errors.push(`unknown category "${entry.category}"`);
  }
  if (typeof entry.title !== 'string' || entry.title.length === 0) {
    errors.push('"title" must be a non-empty string');
  }
  const surfaces = asArray(entry.surfaceIds);
  if (!Array.isArray(entry.surfaceIds)) {
    errors.push('"surfaceIds" must be an array (possibly empty only when notes explain a catalog gap)');
  } else {
    for (const id of surfaces) {
      if (typeof id !== 'string') errors.push(`surface id must be a string (got ${JSON.stringify(id)})`);
      else if (surfaceIds.size > 0 && !surfaceIds.has(id)) {
        errors.push(`unknown surface "${id}" (declare it in manifest/surfaces.json first)`);
      }
    }
  }
  if (typeof entry.currentOwner !== 'string' || entry.currentOwner.length === 0) {
    errors.push('"currentOwner" must name the implementation that owns the region today');
  }
  if (typeof entry.proposedLegoOwner !== 'string' || entry.proposedLegoOwner.length === 0) {
    errors.push('"proposedLegoOwner" must name the proposed LEGO owner');
  }
  if (!statuses.has(entry.migrationStatus)) {
    errors.push(`"migrationStatus" must be one of ${[...statuses].join(', ')}`);
  }
  if (typeof entry.referenceImplementation !== 'string' || entry.referenceImplementation.length === 0) {
    errors.push('"referenceImplementation" must name the pinned reference UI (e.g. n8n-editor-ui@2.9.4)');
  }
  if (!contractStatuses.has(entry.contractStatus)) {
    errors.push(`"contractStatus" must be one of ${[...contractStatuses].join(', ')}`);
  }
  if (entry.evidencePath !== null && typeof entry.evidencePath !== 'string') {
    errors.push('"evidencePath" must be a string path or null');
  } else if (typeof entry.evidencePath === 'string' && entry.evidencePath.length === 0) {
    errors.push('"evidencePath" must be non-empty when present (or null)');
  }
  if (!rollbacks.has(entry.rollbackStrategy)) {
    errors.push(`"rollbackStrategy" must be one of ${[...rollbacks].join(', ')}`);
  }
  if (!Array.isArray(entry.dependencies)) {
    errors.push('"dependencies" must be an array of inventoryIds');
  } else {
    for (const dep of entry.dependencies) {
      if (typeof dep !== 'string') errors.push(`dependency must be an inventoryId string`);
      else if (dep === entry.inventoryId) errors.push('an entry may not depend on itself');
      else if (knownEntries && !knownEntries.has(dep)) errors.push(`unknown dependency "${dep}"`);
    }
  }
  if (typeof entry.notes !== 'string') errors.push('"notes" must be a string');

  // Isolation: inventory is metadata about migration — never credentials or backend authority.
  const banned = ['secret', 'password', 'token', 'apiKey', 'credential', 'privateKey'];
  const flat = JSON.stringify(entry).toLowerCase();
  for (const word of banned) {
    if (flat.includes(word) && !flat.includes('credential security boundary')) {
      // allow the P5 note phrasing; refuse literal secret-shaped keys in the object
      if (Object.prototype.hasOwnProperty.call(entry, word)) {
        errors.push(`field "${word}" must not appear on a migration entry`);
      }
    }
  }
  return errors;
}

/**
 * Validate the whole inventory document against a surface catalog.
 *
 * @param {object} inventory parsed JSON
 * @param {Array<{id:string}>|{id:string}[]} surfaces declared surfaces (manifest/surfaces.json)
 * @returns {{ ok: boolean, errors: string[], entries: object[] }}
 */
export function validateSurfaceMigrationInventory(inventory, surfaces = []) {
  const errors = [];
  if (inventory === null || typeof inventory !== 'object' || Array.isArray(inventory)) {
    return { ok: false, errors: ['inventory must be an object'], entries: [] };
  }
  for (const field of ['inventoryVersion', 'categories', 'migrationStatuses', 'contractStatuses', 'rollbackStrategies', 'entries']) {
    if (inventory[field] === undefined) errors.push(`missing top-level field "${field}"`);
  }
  if (typeof inventory.inventoryVersion === 'string' && !/^\d+\.\d+\.\d+$/.test(inventory.inventoryVersion)) {
    errors.push('"inventoryVersion" must be semver MAJOR.MINOR.PATCH');
  }
  const surfaceList = Array.isArray(surfaces)
    ? surfaces
    : Array.isArray(surfaces?.surfaces)
      ? surfaces.surfaces
      : [];
  const surfaceIdSet = new Set(surfaceList.map((s) => (typeof s === 'string' ? s : s?.id)).filter(Boolean));
  if (surfaceIdSet.size === 0) errors.push('surface catalog is empty — inventory cannot be validated');

  const entries = Array.isArray(inventory.entries) ? inventory.entries : null;
  if (!entries) {
    errors.push('"entries" must be an array');
    return { ok: false, errors, entries: [] };
  }
  if (entries.length === 0) errors.push('"entries" must not be empty');

  const ids = new Set();
  const categories = new Set(Array.isArray(inventory.categories) ? inventory.categories : []);
  const statuses = new Set(Array.isArray(inventory.migrationStatuses) ? inventory.migrationStatuses : MIGRATION_STATUSES);
  const contractStatuses = new Set(Array.isArray(inventory.contractStatuses) ? inventory.contractStatuses : MIGRATION_CONTRACT_STATUSES);
  const rollbacks = new Set(Array.isArray(inventory.rollbackStrategies) ? inventory.rollbackStrategies : ROLLBACK_STRATEGIES);

  // First pass: collect ids for dependency resolution (order-independent).
  for (const entry of entries) {
    if (entry && typeof entry.inventoryId === 'string') {
      if (ids.has(entry.inventoryId)) errors.push(`duplicate inventoryId "${entry.inventoryId}"`);
      ids.add(entry.inventoryId);
    }
  }

  for (const entry of entries) {
    const entryErrors = validateMigrationEntry(entry, {
      surfaceIds: surfaceIdSet,
      knownCategories: categories,
      knownStatuses: statuses,
      knownContractStatuses: contractStatuses,
      knownRollbacks: rollbacks,
      knownEntries: ids,
    });
    for (const err of entryErrors) {
      errors.push(entry?.inventoryId ? `${entry.inventoryId}: ${err}` : err);
    }
  }

  // Required categories present
  for (const category of REQUIRED_CATEGORIES) {
    if (!entries.some((e) => e?.category === category)) {
      errors.push(`missing required category "${category}"`);
    }
  }

  // Status vocabulary in the document must equal the closed set (no silent extension).
  if (JSON.stringify([...statuses].sort()) !== JSON.stringify([...MIGRATION_STATUSES].sort())) {
    errors.push('migrationStatuses must match the closed MIGRATION_STATUSES vocabulary');
  }
  if (JSON.stringify([...contractStatuses].sort()) !== JSON.stringify([...MIGRATION_CONTRACT_STATUSES].sort())) {
    errors.push('contractStatuses must match MIGRATION_CONTRACT_STATUSES');
  }
  if (JSON.stringify([...rollbacks].sort()) !== JSON.stringify([...ROLLBACK_STRATEGIES].sort())) {
    errors.push('rollbackStrategies must match ROLLBACK_STRATEGIES');
  }

  // One pilot PER SLICE. The original rule was "at most one pilot overall", which
  // was correct while #241 was the only migrated surface and became wrong the
  // moment #245 added its own. The invariant worth keeping is the one that
  // actually protects the strangler: one pilot per originating slice, because two
  // pilots stacked on ONE slice is how a reversible migration stops being
  // reversible. So every pilot must name the slice it came from, and no slice may
  // carry two.
  const pilots = entries.filter((e) => e?.migrationStatus === 'pilot-available');
  const pilotOwners = new Set();
  for (const pilot of pilots) {
    const source = pilot.sourceIssue;
    if (typeof source !== 'string' || source.length === 0) {
      errors.push(`pilot "${pilot.inventoryId}" must declare the sourceIssue it came from`);
      continue;
    }
    if (pilotOwners.has(source)) {
      errors.push(`source issue ${source} carries more than one pilot-available entry`);
    }
    pilotOwners.add(source);
  }

  // Dependency edges must not cycle (simple DFS on the small graph).
  const byId = new Map(entries.filter((e) => e?.inventoryId).map((e) => [e.inventoryId, e]));
  const visiting = new Set();
  const done = new Set();
  function visit(id, trail) {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dep)) visit(dep, [...trail, id]);
    }
    visiting.delete(id);
    done.add(id);
  }
  for (const id of byId.keys()) visit(id, []);

  return { ok: errors.length === 0, errors: Object.freeze(errors), entries };
}

/**
 * Describe the inventory for docs / boot-adjacent consumers (metadata only).
 *
 * @param {object} inventory
 * @returns {{ inventoryVersion: string, count: number, byStatus: object, categories: string[], pilotIds: string[] }}
 */
export function describeSurfaceMigration(inventory) {
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const byStatus = Object.create(null);
  for (const status of MIGRATION_STATUSES) byStatus[status] = 0;
  for (const entry of entries) {
    const status = entry?.migrationStatus;
    if (status in byStatus) byStatus[status] += 1;
  }
  return Object.freeze({
    inventoryVersion: inventory?.inventoryVersion ?? null,
    count: entries.length,
    byStatus: Object.freeze({ ...byStatus }),
    categories: Object.freeze([...(inventory?.categories ?? [])]),
    pilotIds: Object.freeze(entries.filter((e) => e?.migrationStatus === 'pilot-available').map((e) => e.inventoryId)),
  });
}
