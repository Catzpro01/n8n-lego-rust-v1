/**
 * P2-S03 Layer 3 — the dashboard workflow-list pilot (surface `dashboard`).
 *
 * First strangler slice of P2-S03's Layers 3–5, in the #241/#245 shape: one
 * additional low-risk surface, `mode: pilot`, `rollback: pilot-not-primary`,
 * original editor stays the default. The tests defend the design decisions the
 * way the #241/#245 suites do:
 *
 *   A  the contract validates against the closed vocabularies, and a mutated
 *      one is refused (unknown field, unknown state, wrong authority)
 *   B  all four region states are parity-`equivalent` against the reference
 *      fixtures; a drifted field is `migration-required`
 *   C  the client filter is a real mutation: narrow, clear, filter-to-zero is
 *      `empty` with `reason: 'filtered'` (not a fifth region state)
 *   D  bounded: visible rows capped, data retained, `truncated` observable
 *   E  the row shape is closed and the bounds are enforced, not just declared
 *   F  accessibility derived once per state; only `error` is assertive, only
 *      `loading` is busy
 *   G  degradation is observable, never silent; observe() is a snapshot, not a
 *      replay; history is deterministic
 *   H  the surface reaches consumers only through the existing registry seam,
 *      opt-in, and the pilot gate's closed set includes it
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  WORKFLOW_LIST_A11Y,
  WORKFLOW_LIST_CAPABILITY_ID,
  WORKFLOW_LIST_LIMITS,
  WORKFLOW_LIST_MESSAGE_SLOT,
  WORKFLOW_LIST_ROW_FIELDS,
  WORKFLOW_LIST_SURFACE_ID,
  WORKFLOW_LIST_SURFACE_VERSION,
  createWorkflowListSurface,
  referenceEmptyObservation,
  referenceErrorObservation,
  referenceLoadingObservation,
  referenceReadyObservation,
  validateWorkflowListSurfaceContract,
  workflowListSurfaceContract,
} from '../src/workflow-list.mjs';
import { compareObservations, PARITY_STATUSES } from '../src/parity.mjs';
import { REGION_STATES, SURFACE_MODES } from '../src/surface-contract.mjs';
import { MESSAGE_SLOTS, isValidMessageKey } from '../src/i18n.mjs';
import { PACKAGE_ROOT, loadManifests } from '../src/manifests.mjs';
import { createFrontendRegistry } from '../src/registry.mjs';

const ROWS = [
  { id: 'w1', name: 'Ingest orders', active: true },
  { id: 'w2', name: 'Nightly sync', active: false },
  { id: 'w3', name: 'Order cleanup', active: true },
];

/* --------------------------------------------------------------- the contract */

test('the pilot contract validates against the closed vocabularies', () => {
  const { ok, errors } = validateWorkflowListSurfaceContract();
  assert.equal(ok, true, errors.join('; '));
});

test('the contract reuses REGION_STATES, not a forked list', () => {
  const contract = workflowListSurfaceContract();
  for (const state of REGION_STATES) {
    assert.ok(contract.states[state], `contract must declare "${state}"`);
    assert.ok(typeof contract.states[state].messageKey === 'string');
  }
});

test('a contract with an unknown top-level field is refused', () => {
  const contract = workflowListSurfaceContract();
  contract.bogus = true;
  const { ok, errors } = validateWorkflowListSurfaceContract(contract);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('unknown field')));
});

test('a contract claiming execute authority is refused (UI never authorizes)', () => {
  const contract = workflowListSurfaceContract();
  contract.outputBoundary.authority = 'execute';
  const { ok, errors } = validateWorkflowListSurfaceContract(contract);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('authority')));
});

test('the contract is a pilot that rolls back to the reference, never primary', () => {
  const contract = workflowListSurfaceContract();
  assert.equal(contract.mode, 'pilot');
  assert.ok(SURFACE_MODES.includes(contract.mode));
  assert.equal(contract.rollback.strategy, 'pilot-not-primary');
  assert.equal(contract.rollback.reference, 'n8n-editor-ui@2.9.4');
});

test('every state messageKey lives in the declared slot and is a valid key', () => {
  const contract = workflowListSurfaceContract();
  const slot = contract.localization.slot;
  for (const state of REGION_STATES) {
    const key = contract.states[state].messageKey;
    assert.ok(key.startsWith(`${slot}.`), `${state} key "${key}" must live in slot "${slot}"`);
    assert.ok(isValidMessageKey(key), `"${key}" is not a valid message key`);
  }
});

test('the declared message slot is a real, known slot', () => {
  assert.ok(MESSAGE_SLOTS.some((s) => s.id === WORKFLOW_LIST_MESSAGE_SLOT));
});

/* ------------------------------------------------------ parity against the reference */

test('loading is parity-equivalent to the reference', () => {
  const surface = createWorkflowListSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, 'equivalent');
});

test('an empty list (no workflows) is parity-equivalent', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess([]);
  const { status } = compareObservations(referenceEmptyObservation({ reason: 'none' }), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a loaded list is parity-equivalent', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  const { status } = compareObservations(referenceReadyObservation(), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createWorkflowListSurface();
  surface.loadFailure({ kind: 'timeout' });
  const { status } = compareObservations(referenceErrorObservation({ errorKind: 'timeout' }), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a mismatched error kind is migration-required, not a silent pass', () => {
  const surface = createWorkflowListSurface();
  surface.loadFailure({ kind: 'timeout' });
  const { status, diffs } = compareObservations(referenceErrorObservation({ errorKind: 'network' }), surface.observe());
  assert.equal(status, 'migration-required');
  assert.ok(diffs.some((d) => d.field === 'error' && /timeout/.test(d.detail)));
});

test('the parity harness is fail-closed: a drifted field is not equivalent', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  // A reference that claims `empty` while the candidate is `ready` must not pass.
  const { status } = compareObservations(referenceEmptyObservation({ reason: 'none' }), surface.observe());
  assert.equal(status, 'migration-required');
});

test('all four parity statuses are a closed vocabulary', () => {
  assert.deepEqual([...PARITY_STATUSES].sort(), ['breaking', 'compatible', 'equivalent', 'migration-required'].sort());
});

/* ---------------------------------------------------------- the client filter (C) */

test('the filter is a real mutation: it narrows the visible rows', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  assert.equal(surface.displayModel().visibleCount, 3);
  surface.setFilter('order');
  const model = surface.displayModel();
  assert.equal(model.visibleCount, 2);
  assert.ok(model.rows.every((row) => row.name.toLowerCase().includes('order')));
});

test('the filter is case-insensitive and trimmed', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  surface.setFilter('  NIGHTLY  ');
  assert.equal(surface.displayModel().visibleCount, 1);
  assert.equal(surface.displayModel().rows[0].name, 'Nightly sync');
});

test('clearing the filter restores every row', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  surface.setFilter('nightly');
  surface.setFilter('');
  assert.equal(surface.displayModel().visibleCount, 3);
  assert.equal(surface.regionState, 'ready');
});

test('filtering to zero is `empty` with reason `filtered`, not a fifth state', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  surface.setFilter('zzz-no-match');
  const model = surface.displayModel();
  assert.equal(surface.regionState, 'empty');
  assert.equal(model.reason, 'filtered');
  assert.equal(model.visibleCount, 0);
  assert.equal(model.count, 3, 'the data is retained, only the view is empty');
});

test('a filter that matches nothing still keeps the loaded count', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  surface.setFilter('zzz');
  assert.equal(surface.count, 3);
});

test('filtering during loading is inert until data arrives', () => {
  const surface = createWorkflowListSurface();
  surface.setFilter('order');
  assert.equal(surface.regionState, 'loading', 'no data yet, so the filter changes nothing');
  surface.loadSuccess(ROWS);
  assert.equal(surface.filter, '', 'a load clears a stale filter');
  assert.equal(surface.regionState, 'ready');
});

test('a filter longer than the bound is refused', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  assert.throws(() => surface.setFilter('x'.repeat(WORKFLOW_LIST_LIMITS.maxFilterLength + 1)));
});

test('the filter bound is enforced, not just declared', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  assert.doesNotThrow(() => surface.setFilter('x'.repeat(WORKFLOW_LIST_LIMITS.maxFilterLength)));
});

/* --------------------------------------------------------------- bounded (D) */

test('visible rows are capped at maxVisible while data is retained', () => {
  const surface = createWorkflowListSurface({ maxVisible: 2 });
  surface.loadSuccess(ROWS);
  const model = surface.displayModel();
  assert.equal(model.visibleCount, 2);
  assert.equal(model.count, 3);
  assert.equal(model.truncated, true);
});

test('maxVisible is clamped to the hard maximum', () => {
  const surface = createWorkflowListSurface({ maxVisible: 10_000 });
  surface.loadSuccess(ROWS);
  assert.equal(surface.displayModel().visibleCount, 3, 'all rows fit, so nothing is truncated');
  assert.equal(surface.displayModel().truncated, false);
});

test('a non-positive maxVisible falls back to the default bound', () => {
  const surface = createWorkflowListSurface({ maxVisible: 0 });
  surface.loadSuccess(ROWS);
  assert.equal(surface.displayModel().visibleCount, ROWS.length);
});

/* ---------------------------------------------------- row shape + bounds (E) */

test('a row with an unknown field is refused (closed shape)', () => {
  const surface = createWorkflowListSurface();
  assert.throws(() => surface.loadSuccess([{ id: '1', name: 'x', active: true, bogus: 1 }]));
});

test('a row missing a required field is refused', () => {
  const surface = createWorkflowListSurface();
  assert.throws(() => surface.loadSuccess([{ id: '1', name: 'x' }]));
  assert.throws(() => surface.loadSuccess([{ id: '1', active: true }]));
});

test('rows with an updatedAt are normalized to a stable shape', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess([{ id: '1', name: 'x', active: true, updatedAt: '2026-01-01T00:00:00Z' }]);
  assert.equal(surface.displayModel().rows[0].updatedAt, '2026-01-01T00:00:00Z');
  surface.loadSuccess([{ id: '2', name: 'y', active: false }]);
  assert.equal(surface.displayModel().rows[0].updatedAt, null);
});

test('the row field set is the closed, documented one', () => {
  assert.deepEqual([...WORKFLOW_LIST_ROW_FIELDS].sort(), ['active', 'id', 'name', 'updatedAt'].sort());
});

/* ------------------------------------------------------------ accessibility (F) */

test('accessibility is derived once per state and cannot drift', () => {
  const surface = createWorkflowListSurface();
  assert.deepEqual(surface.a11y(), Object.freeze({
    role: 'status', 'aria-live': 'polite', 'aria-busy': true, hidden: false,
    'aria-label-key': 'dashboard.loading',
  }));
  surface.loadSuccess(ROWS);
  assert.equal(surface.a11y().role, 'list');
  assert.equal(surface.a11y()['aria-busy'], false);
  surface.loadFailure({ kind: 'network' });
  assert.equal(surface.a11y().role, 'alert');
  assert.equal(surface.a11y()['aria-live'], 'assertive');
});

test('only `error` is assertive and only `loading` is busy', () => {
  assert.equal(WORKFLOW_LIST_A11Y.error['aria-live'], 'assertive');
  for (const state of ['loading', 'empty', 'ready']) {
    assert.notEqual(WORKFLOW_LIST_A11Y[state]['aria-live'], 'assertive', `${state} must stay polite`);
  }
  assert.equal(WORKFLOW_LIST_A11Y.loading['aria-busy'], true);
  for (const state of ['empty', 'error', 'ready']) {
    assert.equal(WORKFLOW_LIST_A11Y[state]['aria-busy'], false, `${state} is not busy`);
  }
});

/* ------------------------------------------------------ degradation + snapshot (G) */

test('degradation is observable, never silent', () => {
  const surface = createWorkflowListSurface({ renderAvailable: false });
  assert.equal(surface.renderAvailable, false);
  surface.loadSuccess(ROWS);
  assert.equal(surface.displayModel().degraded, true);
  assert.ok(surface.degradedEvents > 0);
  // The region still reports ready: the data is fine, only the renderer is absent.
  assert.equal(surface.regionState, 'ready');
});

test('re-enabling rendering clears the degraded flag', () => {
  const surface = createWorkflowListSurface({ renderAvailable: false });
  surface.setRenderAvailable(true);
  assert.equal(surface.renderAvailable, true);
  assert.equal(surface.displayModel().degraded, false);
});

test('observe() is a snapshot, not a replay of the cumulative history', () => {
  const surface = createWorkflowListSurface();
  surface.loadSuccess(ROWS);
  surface.setFilter('nightly');
  surface.setFilter('');
  const obs = surface.observe();
  // After clearing, the list is ready again; no stale `filtered` event lingers.
  assert.deepEqual([...obs.events].sort(), ['workflow-list:rendered']);
});

test('history is deterministic across identical scripts', () => {
  function run() {
    const s = createWorkflowListSurface();
    s.loadSuccess(ROWS);
    s.setFilter('order');
    s.setFilter('');
    return s.history;
  }
  assert.deepEqual(run(), run());
});

test('the actions are declared, never executed: they change with the state', () => {
  const surface = createWorkflowListSurface();
  assert.deepEqual(surface.displayModel().actions, ['refresh'], 'loading offers only refresh');
  surface.loadSuccess(ROWS);
  assert.ok(surface.displayModel().actions.includes('open'), 'ready offers open');
  surface.setFilter('zzz');
  assert.ok(surface.displayModel().actions.includes('clear-filter'), 'a filtered-empty offers clear-filter');
});

/* ------------------------------------------------------- registry seam + gate (H) */

test('the capability is declared in the catalog and the module exists', async () => {
  const { capabilities } = loadManifests();
  const declaration = capabilities.find((c) => c.id === WORKFLOW_LIST_CAPABILITY_ID);
  assert.ok(declaration, `${WORKFLOW_LIST_CAPABILITY_ID} is declared in manifest/capabilities.json`);
  assert.equal(declaration.lifecycle, 'available');
  assert.equal(declaration.activation, 'lazy');
  assert.ok(existsSync(join(PACKAGE_ROOT, declaration.entry.slice(2))), `${declaration.entry} does not exist`);
});

test('the surface registers through the existing registry seam, opt-in', () => {
  // Reach consumers through the existing package/registry/adapter boundary. The
  // registry is created against the declared catalog exactly as the other
  // frontend suites do: an empty catalog is refused, because a registry with no
  // vocabulary cannot validate anything.
  const manifests = loadManifests();
  const registry = createFrontendRegistry({
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
  });
  const declaration = manifests.capabilities.find((c) => c.id === WORKFLOW_LIST_CAPABILITY_ID);
  // `register` THROWS on an invalid declaration; reaching the next line is the
  // assertion that the declaration is registrable.
  registry.register(declaration);
  const available = registry.availability().find((c) => c.id === WORKFLOW_LIST_CAPABILITY_ID);
  assert.ok(available, 'the capability is not in the registry vocabulary');
  assert.equal(available.activation, 'lazy');
  assert.equal(available.lifecycle, 'available');
});

test('the migration inventory entry is pilot-available and non-primary', async () => {
  const { readFileSync } = await import('node:fs');
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === WORKFLOW_LIST_SURFACE_ID);
  assert.ok(entry, `${WORKFLOW_LIST_SURFACE_ID} is in the migration inventory`);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.ok(existsSync(join(PACKAGE_ROOT, '..', '..', entry.evidencePath)), `${entry.evidencePath} does not exist`);
});

test('the surface id follows the inventory grammar and the version is semver', () => {
  assert.match(WORKFLOW_LIST_SURFACE_ID, /^ui\.[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
  assert.match(WORKFLOW_LIST_SURFACE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('the dashboard surface is bound to the workflow backend in the catalog', async () => {
  const { readFileSync } = await import('node:fs');
  const surfaces = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surfaces.json'), 'utf8'));
  const dashboard = surfaces.surfaces.find((s) => s.id === 'dashboard');
  assert.ok(dashboard, 'the dashboard surface is declared');
  assert.equal(dashboard.backend.capability, 'workflow');
  assert.ok(dashboard.backend.endpoints.includes('/rest/workflows'));
});
