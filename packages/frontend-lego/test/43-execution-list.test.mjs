/**
 * P2-S03 Layer 3 — the executions-list pilot (surface `executions`).
 *
 * Third strangler slice of P2-S03's Layers 3-5, in the #241/#245 shape (after
 * P2-S04 dashboard workflow-list and P2-S05 dialogs): one additional low-risk
 * surface, `mode: pilot`, `rollback: pilot-not-primary`, original editor stays
 * the default. The tests defend the design decisions the way the #241/#245/P2-S04
 * suites do:
 *
 *   A  the contract validates against the closed vocabularies, and a mutated
 *      one is refused (unknown field, unknown state, wrong authority)
 *   B  all four region states are parity-`equivalent` against the reference
 *      fixtures; a drifted field is `migration-required`
 *   C  the status filter is a real mutation: narrow, clear, filter-to-zero is
 *      `empty` with `reason: 'filtered'` (not a fifth region state); the
 *      vocabulary is closed and an unknown status is refused
 *   D  bounded: visible rows capped, data retained, `truncated` observable
 *   E  the row shape is closed (id / workflowName / status / lastExecutedAt)
 *      and the status is from the engine vocabulary
 *   F  accessibility derived once per state; only `error` is assertive, only
 *      `loading` is busy
 *   G  degradation is observable, never silent; observe() is a snapshot, not a
 *      replay; history is deterministic
 *   H  the surface reaches consumers only through the existing registry seam,
 *      opt-in; the migration inventory entry is pilot-available + non-primary
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXECUTION_LIST_A11Y,
  EXECUTION_LIST_CAPABILITY_ID,
  EXECUTION_LIST_FILTER_VALUES,
  EXECUTION_LIST_LIMITS,
  EXECUTION_LIST_MESSAGE_SLOT,
  EXECUTION_LIST_ROW_FIELDS,
  EXECUTION_LIST_SURFACE_ID,
  EXECUTION_LIST_SURFACE_VERSION,
  EXECUTION_STATUSES,
  createExecutionListSurface,
  referenceEmptyObservation,
  referenceErrorObservation,
  referenceLoadingObservation,
  referenceReadyObservation,
  validateExecutionListSurfaceContract,
  executionListSurfaceContract,
} from '../src/execution-list.mjs';
import { compareObservations, PARITY_STATUSES } from '../src/parity.mjs';
import { REGION_STATES, SURFACE_MODES } from '../src/surface-contract.mjs';
import { MESSAGE_SLOTS, isValidMessageKey } from '../src/i18n.mjs';
import { PACKAGE_ROOT, loadManifests } from '../src/manifests.mjs';
import { createFrontendRegistry } from '../src/registry.mjs';

/** A small, deterministic handed-over execution list. */
const EXECUTIONS = [
  { id: 'e1', workflowName: 'Order import', status: 'success', lastExecutedAt: '2026-09-01T10:00:00Z' },
  { id: 'e2', workflowName: 'Nightly sync', status: 'error', lastExecutedAt: '2026-09-01T11:00:00Z' },
  { id: 'e3', workflowName: 'Order export', status: 'running', lastExecutedAt: '2026-09-01T12:00:00Z' },
];

/* ------------------------------------------------------------------ the contract (A) */

test('the contract validates against the closed vocabularies', () => {
  const { ok, errors } = validateExecutionListSurfaceContract();
  assert.equal(ok, true, errors.join('; '));
});

test('a contract with an unknown top-level field is refused (closed shape)', () => {
  const contract = executionListSurfaceContract();
  contract.bogus = true;
  const { ok, errors } = validateExecutionListSurfaceContract(contract);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('unknown field')));
});

test('the contract states are keyed on REGION_STATES exactly', () => {
  const contract = executionListSurfaceContract();
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
});

test('the contract is a pilot with a pilot-not-primary rollback', () => {
  const contract = executionListSurfaceContract();
  assert.equal(contract.mode, 'pilot');
  assert.ok(SURFACE_MODES.includes(contract.mode));
  assert.equal(contract.rollback.strategy, 'pilot-not-primary');
  assert.equal(contract.rollback.reference, 'n8n-editor-ui@2.9.4');
});

test('the input boundary is a hand-over, never a fetch', () => {
  const contract = executionListSurfaceContract();
  assert.equal(contract.inputBoundary.source, 'hand-over');
});

test('the authority is declare-request-render, and a wrong authority is refused', () => {
  const contract = executionListSurfaceContract();
  assert.equal(contract.outputBoundary.authority, 'declare-request-render');
  contract.outputBoundary.authority = 'execute';
  const { ok, errors } = validateExecutionListSurfaceContract(contract);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes('authority')));
});

test('the region-state message keys are valid keys in a declared slot', () => {
  const contract = executionListSurfaceContract();
  assert.ok(MESSAGE_SLOTS.some((s) => s.id === EXECUTION_LIST_MESSAGE_SLOT), 'the slot is declared');
  for (const state of REGION_STATES) {
    assert.ok(isValidMessageKey(contract.states[state].messageKey), `${state} message key is valid`);
  }
});

test('the execution status vocabulary is closed and the filter vocabulary is all + statuses', () => {
  assert.ok(EXECUTION_STATUSES.includes('success'));
  assert.ok(EXECUTION_STATUSES.includes('error'));
  assert.ok(EXECUTION_STATUSES.includes('canceled'));
  assert.ok(EXECUTION_STATUSES.includes('running'));
  assert.deepEqual([...EXECUTION_LIST_FILTER_VALUES].sort(), ['all', ...EXECUTION_STATUSES].sort());
});

/* ------------------------------------------------------------------ parity (B) */

test('loading is parity-equivalent to the reference', () => {
  const surface = createExecutionListSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, 'equivalent');
});

test('an empty list (no executions) is parity-equivalent', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess([]);
  const { status } = compareObservations(referenceEmptyObservation({ reason: 'none' }), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a loaded list is parity-equivalent', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  const { status } = compareObservations(referenceReadyObservation(), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createExecutionListSurface();
  surface.loadFailure({ kind: 'timeout' });
  const { status } = compareObservations(referenceErrorObservation({ errorKind: 'timeout' }), surface.observe());
  assert.equal(status, 'equivalent');
});

test('a mismatched error kind is migration-required, not a silent pass', () => {
  const surface = createExecutionListSurface();
  surface.loadFailure({ kind: 'timeout' });
  const { status, diffs } = compareObservations(referenceErrorObservation({ errorKind: 'network' }), surface.observe());
  assert.equal(status, 'migration-required');
  assert.ok(diffs.some((d) => d.field === 'error'));
});

test('the parity harness is fail-closed: a drifted field is not equivalent', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  // Force a drift: the candidate is ready, the reference claims empty.
  const { status } = compareObservations(referenceEmptyObservation({ reason: 'none' }), surface.observe());
  assert.equal(status, 'migration-required');
});

test('all four parity statuses are a closed vocabulary', () => {
  assert.deepEqual([...PARITY_STATUSES].sort(), ['breaking', 'compatible', 'equivalent', 'migration-required'].sort());
});

/* ------------------------------------------------------- the status filter (C) */

test('the status filter is a real mutation: it narrows the visible rows', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  assert.equal(surface.displayModel().visibleCount, 3);
  surface.setStatusFilter('success');
  const model = surface.displayModel();
  assert.equal(model.visibleCount, 1);
  assert.equal(model.rows[0].workflowName, 'Order import');
});

test('filtering by `all` shows every row', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  surface.setStatusFilter('error');
  surface.setStatusFilter('all');
  assert.equal(surface.displayModel().visibleCount, 3);
  assert.equal(surface.regionState, 'ready');
});

test('filtering to zero is `empty` with reason `filtered`, not a fifth state', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  surface.setStatusFilter('waiting'); // none of the fixture rows are waiting
  const model = surface.displayModel();
  assert.equal(surface.regionState, 'empty');
  assert.equal(model.reason, 'filtered');
  assert.equal(model.visibleCount, 0);
  assert.equal(model.count, 3, 'the data is retained, only the view is empty');
});

test('a filter that matches nothing still keeps the loaded count', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  surface.setStatusFilter('canceled');
  assert.equal(surface.count, 3);
});

test('an unknown status filter is refused (closed vocabulary)', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  assert.throws(() => surface.setStatusFilter('bogus'));
  assert.throws(() => surface.setStatusFilter(''));
});

test('filtering during loading is inert until data arrives', () => {
  const surface = createExecutionListSurface();
  surface.setStatusFilter('error');
  assert.equal(surface.regionState, 'loading', 'no data yet, so the filter changes nothing');
  surface.loadSuccess(EXECUTIONS);
  assert.equal(surface.statusFilter, 'all', 'a load resets a stale filter');
  assert.equal(surface.regionState, 'ready');
});

test('the statusFilter getter reflects the current selection', () => {
  const surface = createExecutionListSurface();
  assert.equal(surface.statusFilter, 'all');
  surface.loadSuccess(EXECUTIONS);
  surface.setStatusFilter('running');
  assert.equal(surface.statusFilter, 'running');
});

/* ----------------------------------------------------------------- bounded (D) */

test('visible rows are capped at maxVisible while data is retained', () => {
  const many = EXECUTIONS.concat(
    { id: 'e4', workflowName: 'Invoice run', status: 'success', lastExecutedAt: '2026-09-02T00:00:00Z' },
    { id: 'e5', workflowName: 'Webhook run', status: 'error', lastExecutedAt: '2026-09-02T01:00:00Z' },
  );
  const surface = createExecutionListSurface({ maxVisible: 2 });
  surface.loadSuccess(many);
  const model = surface.displayModel();
  assert.equal(model.visibleCount, 2);
  assert.equal(model.count, 5);
  assert.equal(model.truncated, true);
});

test('maxVisible is clamped to the hard maximum', () => {
  const surface = createExecutionListSurface({ maxVisible: 10_000 });
  surface.loadSuccess(EXECUTIONS);
  assert.equal(surface.displayModel().visibleCount, 3, 'all rows fit, so nothing is truncated');
  assert.equal(surface.displayModel().truncated, false);
});

test('a non-positive maxVisible falls back to the default bound', () => {
  const surface = createExecutionListSurface({ maxVisible: 0 });
  surface.loadSuccess(EXECUTIONS);
  assert.equal(surface.displayModel().visibleCount, EXECUTIONS.length);
});

test('the default visible bound is the documented one', () => {
  assert.equal(EXECUTION_LIST_LIMITS.maxVisible, 20);
  assert.equal(EXECUTION_LIST_LIMITS.hardMaxVisible, 50);
});

/* ------------------------------------------------------- row shape (E) */

test('a row with an unknown field is refused (closed shape)', () => {
  const surface = createExecutionListSurface();
  assert.throws(() => surface.loadSuccess([{ id: '1', workflowName: 'x', status: 'success', bogus: 1 }]));
});

test('a row missing a required field is refused', () => {
  const surface = createExecutionListSurface();
  assert.throws(() => surface.loadSuccess([{ id: '1', workflowName: 'x' }]));
  assert.throws(() => surface.loadSuccess([{ id: '1', status: 'success' }]));
});

test('a row with an unknown status is refused (engine vocabulary)', () => {
  const surface = createExecutionListSurface();
  assert.throws(() => surface.loadSuccess([{ id: '1', workflowName: 'x', status: 'new' }]));
  assert.throws(() => surface.loadSuccess([{ id: '1', workflowName: 'x', status: 'SUCCESS' }]));
});

test('rows are normalized to a stable shape', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess([{ id: '1', workflowName: 'x', status: 'success', lastExecutedAt: '2026-01-01T00:00:00Z' }]);
  assert.equal(surface.displayModel().rows[0].lastExecutedAt, '2026-01-01T00:00:00Z');
  surface.loadSuccess([{ id: '2', workflowName: 'y', status: 'error' }]);
  assert.equal(surface.displayModel().rows[0].lastExecutedAt, null);
});

test('the row field set is the closed, documented one', () => {
  assert.deepEqual([...EXECUTION_LIST_ROW_FIELDS].sort(), ['id', 'lastExecutedAt', 'status', 'workflowName'].sort());
});

/* ------------------------------------------------------------ accessibility (F) */

test('accessibility is derived once per state and cannot drift', () => {
  const surface = createExecutionListSurface();
  assert.deepEqual(surface.a11y(), Object.freeze({
    role: 'status', 'aria-live': 'polite', 'aria-busy': true, hidden: false,
    'aria-label-key': 'empty-states.loading',
  }));
  surface.loadSuccess(EXECUTIONS);
  assert.equal(surface.a11y().role, 'list');
  assert.equal(surface.a11y()['aria-busy'], false);
  surface.loadFailure({ kind: 'network' });
  assert.equal(surface.a11y().role, 'alert');
  assert.equal(surface.a11y()['aria-live'], 'assertive');
});

test('only `error` is assertive and only `loading` is busy', () => {
  assert.equal(EXECUTION_LIST_A11Y.error['aria-live'], 'assertive');
  for (const state of ['loading', 'empty', 'ready']) {
    assert.notEqual(EXECUTION_LIST_A11Y[state]['aria-live'], 'assertive', `${state} must stay polite`);
  }
  assert.equal(EXECUTION_LIST_A11Y.loading['aria-busy'], true);
  for (const state of ['empty', 'error', 'ready']) {
    assert.equal(EXECUTION_LIST_A11Y[state]['aria-busy'], false, `${state} is not busy`);
  }
});

/* ------------------------------------------------------ degradation + snapshot (G) */

test('degradation is observable, never silent', () => {
  const surface = createExecutionListSurface({ renderAvailable: false });
  assert.equal(surface.renderAvailable, false);
  surface.loadSuccess(EXECUTIONS);
  assert.equal(surface.displayModel().degraded, true);
  assert.ok(surface.degradedEvents > 0);
  // The region still reports ready: the data is fine, only the renderer is absent.
  assert.equal(surface.regionState, 'ready');
});

test('re-enabling rendering clears the degraded flag', () => {
  const surface = createExecutionListSurface({ renderAvailable: false });
  surface.setRenderAvailable(true);
  assert.equal(surface.renderAvailable, true);
  assert.equal(surface.displayModel().degraded, false);
});

test('observe() is a snapshot, not a replay of the cumulative history', () => {
  const surface = createExecutionListSurface();
  surface.loadSuccess(EXECUTIONS);
  surface.setStatusFilter('error');
  surface.setStatusFilter('all');
  const obs = surface.observe();
  // After clearing, the list is ready again; no stale `filtered` event lingers.
  assert.deepEqual([...obs.events].sort(), ['execution-list:rendered']);
});

test('history is deterministic across identical scripts', () => {
  function run() {
    const s = createExecutionListSurface();
    s.loadSuccess(EXECUTIONS);
    s.setStatusFilter('error');
    s.setStatusFilter('all');
    return s.history;
  }
  assert.deepEqual(run(), run());
});

test('the actions are declared, never executed: they change with the state', () => {
  const surface = createExecutionListSurface();
  assert.deepEqual(surface.displayModel().actions, ['refresh'], 'loading offers only refresh');
  surface.loadSuccess(EXECUTIONS);
  assert.ok(surface.displayModel().actions.includes('open'), 'ready offers open');
  surface.setStatusFilter('waiting');
  assert.ok(surface.displayModel().actions.includes('clear-filter'), 'a filtered-empty offers clear-filter');
});

/* ------------------------------------------------------- registry seam + gate (H) */

test('the capability is declared in the catalog and the module exists', async () => {
  const { capabilities } = loadManifests();
  const declaration = capabilities.find((c) => c.id === EXECUTION_LIST_CAPABILITY_ID);
  assert.ok(declaration, `${EXECUTION_LIST_CAPABILITY_ID} is declared in manifest/capabilities.json`);
  assert.equal(declaration.lifecycle, 'available');
  assert.equal(declaration.activation, 'lazy');
  assert.ok(existsSync(join(PACKAGE_ROOT, declaration.entry.slice(2))), `${declaration.entry} does not exist`);
});

test('the surface registers through the existing registry seam, opt-in', () => {
  const manifests = loadManifests();
  const registry = createFrontendRegistry({
    surfaces: manifests.surfaces,
    extensionPoints: manifests.extensionPoints,
  });
  const declaration = manifests.capabilities.find((c) => c.id === EXECUTION_LIST_CAPABILITY_ID);
  // `register` THROWS on an invalid declaration; reaching the next line is the
  // assertion that the declaration is registrable.
  registry.register(declaration);
  const available = registry.availability().find((c) => c.id === EXECUTION_LIST_CAPABILITY_ID);
  assert.ok(available, 'the capability is not in the registry vocabulary');
  assert.equal(available.activation, 'lazy');
  assert.equal(available.lifecycle, 'available');
});

test('the migration inventory entry is pilot-available and non-primary', async () => {
  const { readFileSync } = await import('node:fs');
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === EXECUTION_LIST_SURFACE_ID);
  assert.ok(entry, `${EXECUTION_LIST_SURFACE_ID} is in the migration inventory`);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.ok(existsSync(join(PACKAGE_ROOT, '..', '..', entry.evidencePath)), `${entry.evidencePath} does not exist`);
});

test('the surface id follows the inventory grammar and the version is semver', () => {
  assert.match(EXECUTION_LIST_SURFACE_ID, /^ui\.[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
  assert.match(EXECUTION_LIST_SURFACE_VERSION, /^\d+\.\d+\.\d+$/);
});

test('the executions surface is bound to the execution backend in the catalog', async () => {
  const { readFileSync } = await import('node:fs');
  const surfaces = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surfaces.json'), 'utf8'));
  const executions = surfaces.surfaces.find((s) => s.id === 'executions');
  assert.ok(executions, 'the executions surface is declared');
  assert.equal(executions.backend.capability, 'execution');
  assert.ok(executions.backend.endpoints.includes('/rest/executions'));
});
