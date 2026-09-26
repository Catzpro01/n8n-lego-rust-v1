/**
 * Issue #241 — Scope A + B: surface migration inventory & surface contract.
 *
 * Proves the inventory is machine-readable, schema-validated, references only
 * declared surfaces, covers every required category, and that the migration
 * contract reuses existing Frontend LEGO vocabulary (no second architecture).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIGRATION_STATUSES,
  REQUIRED_CATEGORIES,
  validateSurfaceMigrationInventory,
  describeSurfaceMigration,
} from '../src/surface-migration.mjs';
import {
  REGION_STATES,
  SURFACE_MODES,
  defineSurfaceContract,
  validateSurfaceContract,
  describeSurfaceContract,
  surfaceRunnable,
} from '../src/surface-contract.mjs';
import { CAPABILITY_STATES } from '../src/lifecycle.mjs';
import { INTERACTION_CLASSES } from '../src/interactions.mjs';
import { TRANSPORT_KINDS } from '../src/transport.mjs';
import { MESSAGE_SLOTS } from '../src/i18n.mjs';
import { ERROR_KINDS } from '../src/errors.mjs';
import { PACKAGE_ROOT, loadManifests } from '../src/manifests.mjs';

const manifests = loadManifests();
const inventory = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'),
);

const catalog = {
  knownSurfaceIds: new Set(manifests.surfaces.map((s) => s.id)),
  knownCapabilities: new Set(manifests.capabilities.map((c) => c.id).concat(['reference-ui'])),
  knownMessageSlots: new Set(MESSAGE_SLOTS.map((s) => s.id)),
};

test('the migration inventory is valid against the surface catalog', () => {
  const result = validateSurfaceMigrationInventory(inventory, manifests.surfaces);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.ok(result.entries.length >= REQUIRED_CATEGORIES.length, 'at least one entry per major category family');
});

test('every required category from Issue #241 is represented', () => {
  const categories = new Set(inventory.categories);
  for (const required of REQUIRED_CATEGORIES) {
    assert.ok(categories.has(required), `catalog lists ${required}`);
    assert.ok(
      inventory.entries.some((e) => e.category === required),
      `entries cover ${required}`,
    );
  }
});

test('entries reference only declared surfaces and stable inventory ids', () => {
  const surfaceIds = new Set(manifests.surfaces.map((s) => s.id));
  const ids = new Set();
  for (const entry of inventory.entries) {
    assert.match(entry.inventoryId, /^ui\.[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
    assert.equal(ids.has(entry.inventoryId), false, `unique id ${entry.inventoryId}`);
    ids.add(entry.inventoryId);
    for (const surfaceId of entry.surfaceIds) {
      assert.ok(surfaceIds.has(surfaceId), `${entry.inventoryId} → ${surfaceId} exists in surfaces.json`);
    }
    assert.equal(typeof entry.currentOwner, 'string');
    assert.equal(typeof entry.proposedLegoOwner, 'string');
    assert.ok(MIGRATION_STATUSES.includes(entry.migrationStatus));
    assert.ok(typeof entry.rollbackStrategy === 'string' && entry.rollbackStrategy.length > 0);
    assert.ok(Array.isArray(entry.dependencies));
    assert.equal(typeof entry.notes, 'string');
  }
});

test('the inventory is not a second surface catalog and carries no secrets', () => {
  const raw = JSON.stringify(inventory).toLowerCase();
  assert.equal(raw.includes('ghp_'), false);
  assert.equal(raw.includes('"password"'), false);
  assert.equal(raw.includes('"privatekey"'), false);
  // No endpoint authority or backend implementation paths
  assert.equal(raw.includes('select '), false);
  // Every entry points at surfaces.json vocabulary rather than inventing surface titles as ids
  for (const entry of inventory.entries) {
    assert.ok(entry.surfaceIds.length >= 1, `${entry.inventoryId} binds to at least one declared surface`);
  }
});

test('one pilot per slice, and every pilot names its slice', () => {
  // Was "exactly one pilot overall", true while #241 was the only migrated
  // surface. #245 adds its own pilot, so the gate is now the closed set with the
  // provenance that makes the per-slice rule enforceable.
  const pilots = inventory.entries.filter((e) => e.migrationStatus === 'pilot-available');
  assert.deepEqual(
    pilots.map((e) => e.inventoryId).sort(),
    ['ui.pages.dashboard', 'ui.primitives.notification-surface', 'ui.primitives.status-region'],
  );
  const sources = pilots.map((e) => e.sourceIssue).sort();
  assert.deepEqual(sources, ['240', '241', '245'], 'each pilot names the slice it came from');
  assert.equal(new Set(sources).size, sources.length, 'two pilots share one slice');
  for (const pilot of pilots) {
    assert.equal(pilot.rollbackStrategy, 'pilot-not-primary', `${pilot.inventoryId} claims primacy`);
  }
});

test('describeSurfaceMigration summarizes status without loading code', () => {
  const described = describeSurfaceMigration(inventory);
  assert.equal(described.count, inventory.entries.length);
  assert.deepEqual([...described.pilotIds].sort(), ['ui.pages.dashboard', 'ui.primitives.notification-surface', 'ui.primitives.status-region']);
  const total = Object.values(described.byStatus).reduce((a, b) => a + b, 0);
  assert.equal(total, described.count);
});

test('the surface migration contract reuses existing vocabulary (no second systems)', () => {
  const contract = defineSurfaceContract({
    id: 'ui.primitives.status-region',
    version: '1.0.0',
    title: 'Status region',
    mode: 'pilot',
    lifecycleState: 'available',
    capabilityRequirements: [
      { id: 'status-region', criticality: 'optional' },
    ],
    inputBoundary: { fields: ['regionState'], source: 'hand-over' },
    outputBoundary: { events: ['status-region:retry'], authority: 'declare-request-render' },
    interaction: 'event',
    transport: 'local',
    localization: { slot: 'system-messages', fallbackLocale: 'en' },
    accessibility: { observables: ['role', 'aria-busy'] },
    states: {
      loading: { messageKey: 'system-messages.status-loading' },
      empty: { messageKey: 'system-messages.status-empty' },
      error: { messageKey: 'system-messages.status-error', errorKind: 'network' },
      ready: { messageKey: 'system-messages.status-ready' },
    },
    observability: { events: ['pilot.status-region.rendered'] },
    rollback: { strategy: 'pilot-not-primary', reference: 'n8n-editor-ui@2.9.4' },
  });

  const { ok, errors } = validateSurfaceContract(contract, catalog);
  assert.equal(ok, true, errors.join('; '));

  // Vocabulary reuse — these sets come from the existing package modules.
  assert.ok(CAPABILITY_STATES.includes(contract.lifecycleState));
  assert.ok(INTERACTION_CLASSES.includes(contract.interaction));
  assert.ok(TRANSPORT_KINDS.includes(contract.transport));
  assert.ok(REGION_STATES.every((s) => contract.states[s]));
  assert.ok(SURFACE_MODES.includes(contract.mode));
  assert.equal(contract.outputBoundary.authority, 'declare-request-render');
  assert.equal(surfaceRunnable(contract), false, 'available is declared but not runnable');
});

test('the surface contract fails closed on authority leakage and unknown fields', () => {
  const base = {
    id: 'ui.bad.contract',
    version: '1.0.0',
    title: 'Bad',
    mode: 'pilot',
    lifecycleState: 'available',
    capabilityRequirements: [{ id: 'status-region', criticality: 'optional' }],
    inputBoundary: { fields: [], source: 'hand-over' },
    outputBoundary: { events: [], authority: 'declare-request-render' },
    interaction: 'event',
    transport: 'local',
    localization: { slot: 'system-messages' },
    accessibility: { observables: ['role'] },
    states: {
      loading: { messageKey: 'system-messages.a' },
      empty: { messageKey: 'system-messages.b' },
      error: { messageKey: 'system-messages.c' },
      ready: { messageKey: 'system-messages.d' },
    },
    observability: { events: ['x'] },
    rollback: { strategy: 'pilot-not-primary', reference: 'n8n-editor-ui@2.9.4' },
  };

  const authority = validateSurfaceContract(
    { ...base, outputBoundary: { events: [], authority: 'authorize-session' } },
    catalog,
  );
  assert.equal(authority.ok, false);
  assert.ok(authority.errors.some((e) => e.includes('declare-request-render')));

  const secret = validateSurfaceContract(
    { ...base, inputBoundary: { fields: ['password'], source: 'hand-over' } },
    catalog,
  );
  assert.equal(secret.ok, false);
  assert.ok(secret.errors.some((e) => e.includes('password')));

  const extra = validateSurfaceContract({ ...base, secondRegistry: true }, catalog);
  assert.equal(extra.ok, false);
  assert.ok(extra.errors.some((e) => e.includes('unknown field')));

  const badMode = validateSurfaceContract({ ...base, mode: 'big-bang' }, catalog);
  assert.equal(badMode.ok, false);
});

test('inventory rejects unknown surfaces and duplicate ids (fail-closed)', () => {
  const broken = JSON.parse(JSON.stringify(inventory));
  broken.entries[0].surfaceIds = ['not-a-surface'];
  broken.entries[1].inventoryId = broken.entries[0].inventoryId;
  const result = validateSurfaceMigrationInventory(broken, manifests.surfaces);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not-a-surface')));
  assert.ok(result.errors.some((e) => e.includes('duplicate inventoryId')));
});

test('describeSurfaceContract exposes deterministic summary fields', () => {
  const contract = defineSurfaceContract({
    id: 'ui.shell.navigation',
    version: '1.0.0',
    title: 'Nav',
    mode: 'reference',
    lifecycleState: 'available',
    capabilityRequirements: [{ id: 'reference-ui', criticality: 'optional' }],
    inputBoundary: { fields: [] },
    outputBoundary: { events: ['nav:go'] },
    interaction: 'event',
    transport: 'local',
    localization: { slot: 'navigation' },
    accessibility: { observables: ['role'] },
    states: {
      loading: { messageKey: 'navigation.loading' },
      empty: { messageKey: 'navigation.empty' },
      error: { messageKey: 'navigation.error' },
      ready: { messageKey: 'navigation.ready' },
    },
    observability: { events: ['nav.rendered'] },
    rollback: { strategy: 'reference-remains-default', reference: 'n8n-editor-ui@2.9.4' },
  });
  const described = describeSurfaceContract(contract);
  assert.equal(described.id, 'ui.shell.navigation');
  assert.equal(described.authority, 'declare-request-render');
  assert.deepEqual([...described.regionStates], [...REGION_STATES]);
  // errorKind vocabulary still comes from errors.mjs when used
  assert.ok(ERROR_KINDS.includes('network'));
  const withKind = { ...contract, states: { ...contract.states, error: { messageKey: 'navigation.error', errorKind: 'nope' } } };
  const bad = validateSurfaceContract(withKind, catalog);
  assert.equal(bad.ok, false);
});
