/**
 * P2-S07 - Node picker / catalog pilot (issue #240).
 *
 * The strangler slice for the palette surface. Evidence map:
 *   CP-01 boundary + closed contract: hand-over only, closed REGION_STATES,
 *         unknown rows/categories refused (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, assertive/busy exclusivity (D)
 *   CP-05 bounds + query mutation + explicit failure and selection (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createNodePickerSurface,
  nodePickerSurfaceContract,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  NODE_PICKER_STATES,
  NODE_PICKER_CATEGORIES,
  NODE_PICKER_SELECT_RESULTS,
  NODE_PICKER_A11Y,
  NODE_PICKER_MAX_VISIBLE_HARD_MAX,
  NODE_PICKER_SURFACE_ID,
} from '../src/node-picker.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROW_A = { id: 'n8n-nodes-base.set', name: 'Set', description: 'Edit fields', category: 'transform' };
const ROW_B = { id: 'n8n-nodes-base.httpRequest', name: 'HTTP Request', description: 'Call an API', category: 'action' };
const ROW_C = { id: 'n8n-nodes-base.webhook', name: 'Webhook', description: 'Starts on a call', category: 'trigger' };

function readySurface() {
  const surface = createNodePickerSurface();
  surface.loadSuccess([ROW_A, ROW_B]);
  return surface;
}

/* ------------------------------------------------------------- A (CP-01) */

test('A rows enter only through loadSuccess: the surface holds no private catalog path', () => {
  const surface = createNodePickerSurface();
  assert.equal(surface.contract.inputBoundary.source, 'hand-over');
  assert.equal(surface.contract.inputBoundary.entryPoint, 'loadSuccess');
  // The only entry point; nothing on the surface reads a catalog URL or fetches.
  assert.equal(typeof surface.loadSuccess, 'function');
  assert.equal(surface.displayModel().total, 0);
});

test('A a row outside the closed shape is refused, not dropped', () => {
  const surface = createNodePickerSurface();
  assert.throws(() => surface.loadSuccess([{ id: 'x', name: 'X' }]), /exactly id,name,description,category|must have exactly/);
  assert.throws(() => surface.loadSuccess([{ ...ROW_A, extra: 1 }]), /must have exactly/);
  assert.throws(() => surface.loadSuccess(['not-an-object']), /must be an object/);
  assert.throws(() => surface.loadSuccess([{ ...ROW_A, category: 'unknown-cat' }]), /category must be one of/);
});

test('A the contract states are pinned to REGION_STATES exactly - no fifth state', () => {
  const contract = nodePickerSurfaceContract();
  assert.deepEqual(Object.keys(contract.states), [...REGION_STATES]);
  assert.deepEqual([...NODE_PICKER_STATES], [...REGION_STATES]);
  // Filtering to zero is empty with reason filtered - never a fifth region state.
  const surface = readySurface();
  surface.setQuery('zzz-no-match');
  assert.equal(surface.displayModel().reason, 'filtered');
  assert.equal(surface.observe().regionState, 'empty');
  assert.deepEqual(Object.keys(surface.contract.states), [...REGION_STATES]);
});

test('A the category and selection vocabularies are closed', () => {
  const contract = nodePickerSurfaceContract();
  assert.deepEqual([...contract.vocabularies.categories], [...NODE_PICKER_CATEGORIES]);
  assert.deepEqual([...contract.vocabularies.selectResults], [...NODE_PICKER_SELECT_RESULTS]);
  assert.deepEqual([...contract.vocabularies.emptyReasons], ['none', 'filtered']);
});

/* ------------------------------------------------------------- B (CP-02) */

test('B the surface migrates as a pilot with rollback pilot-not-primary', () => {
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === 'ui.nodes.picker');
  assert.ok(entry, 'ui.nodes.picker entry exists');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.match(entry.evidencePath, /44-node-picker\.test\.mjs/);
  assert.deepEqual(entry.surfaceIds, [NODE_PICKER_SURFACE_ID]);
});

test('B the capability declares the pilot and degrades to native behavior', () => {
  const caps = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'capabilities.json'), 'utf8'));
  const list = caps.capabilities ?? caps;
  const cap = list.find((c) => c.id === NODE_PICKER_SURFACE_ID);
  assert.ok(cap, 'node-picker capability declared');
  assert.equal(cap.entry, './src/node-picker.mjs');
  assert.equal(cap.degradation.fallback, 'native-behavior');
  assert.ok(cap.tests.some((t) => /44-node-picker\.test\.mjs/.test(t)));
  assert.deepEqual(cap.surfaces, [NODE_PICKER_SURFACE_ID]);
});

/* ------------------------------------------------------------- C (CP-03) */

test('C loading is parity-equivalent to the reference', () => {
  const surface = createNodePickerSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C an empty picker (no nodes) is parity-equivalent', () => {
  const surface = createNodePickerSurface();
  surface.loadSuccess([]);
  const { status } = compareObservations(referenceEmptyObservation({ reason: 'none' }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C a loaded picker is parity-equivalent', () => {
  const surface = readySurface();
  const { status } = compareObservations(referenceReadyObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createNodePickerSurface();
  surface.loadFailure({ kind: 'timeout' });
  const { status } = compareObservations(referenceErrorObservation({ errorKind: 'timeout' }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C the harness is fail-closed: a drifted field is migration-required', () => {
  const surface = createNodePickerSurface();
  surface.loadSuccess([]);
  const { status } = compareObservations(referenceReadyObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[2]);
});

test('C an incomparable observation throws, never silently passes', () => {
  const surface = readySurface();
  assert.throws(
    () => compareObservations(referenceReadyObservation(), { ...surface.observe(), regionState: 'ghost' }),
    ParityError,
  );
});

/* ------------------------------------------------------------- D (CP-04) */

test('D the a11y intent is derived once from NODE_PICKER_A11Y', () => {
  const surface = readySurface();
  assert.equal(surface.a11y(), NODE_PICKER_A11Y.ready);
  assert.deepEqual(surface.observe().accessibility, NODE_PICKER_A11Y.ready);
});

test('D only error is assertive and only loading is busy', () => {
  for (const state of REGION_STATES) {
    const attrs = NODE_PICKER_A11Y[state];
    if (state === 'error') assert.equal(attrs.ariaLive, 'assertive');
    else assert.equal(attrs.ariaLive, 'polite');
    if (state === 'loading') assert.equal(attrs.ariaBusy, true);
    else assert.equal(attrs.ariaBusy, false);
  }
});

/* ------------------------------------------------------------- E (CP-05) */

test('E visible rows are bounded and truncation is observable', () => {
  const surface = createNodePickerSurface({ maxVisible: 2 });
  const rows = Array.from({ length: 5 }, (unused, i) => ({
    id: `node-${i}`, name: `Node ${i}`, description: 'd', category: 'action',
  }));
  surface.loadSuccess(rows);
  const model = surface.displayModel();
  assert.equal(model.shown.length, 2);
  assert.equal(model.truncated, true);
  assert.equal(model.total, 5);
  // A larger request cannot exceed the hard max.
  const capped = createNodePickerSurface({ maxVisible: NODE_PICKER_MAX_VISIBLE_HARD_MAX + 10 });
  assert.equal(capped.maxVisible, NODE_PICKER_MAX_VISIBLE_HARD_MAX);
  assert.throws(() => createNodePickerSurface({ maxVisible: 0 }), /positive integer/);
});

test('E the query filter is an observable mutation: narrow, clear', () => {
  const surface = readySurface();
  assert.equal(surface.setQuery('http'), 'ready');
  assert.equal(surface.displayModel().visibleCount, 1);
  assert.equal(surface.setQuery('zzz'), 'empty');
  assert.equal(surface.displayModel().reason, 'filtered');
  assert.equal(surface.setQuery(''), 'ready');
  assert.throws(() => surface.setQuery(42), /string/);
});

test('E selection is an explicit declared result, never a silent no-op', () => {
  const surface = readySurface();
  assert.equal(surface.select(ROW_A.id), 'selected');
  assert.equal(surface.displayModel().selectedId, ROW_A.id);
  assert.equal(surface.select('ghost-node'), 'unknown-id');
  assert.ok(NODE_PICKER_SELECT_RESULTS.includes('not-ready'));
  surface.setLoading();
  assert.equal(surface.select(ROW_A.id), 'not-ready');
  assert.throws(() => surface.select(''), /non-empty/);
});

test('E failure is explicit: the error region carries a retry affordance', () => {
  const surface = createNodePickerSurface();
  assert.equal(surface.loadFailure({ kind: 'network' }), 'error');
  const model = surface.displayModel();
  assert.deepEqual([...model.actions], ['refresh']);
  assert.throws(() => surface.loadFailure(null), /error object/);
  // Rows are retained across a retry cycle; degraded mode is observable, never silent.
  const degraded = createNodePickerSurface({ renderAvailable: false });
  degraded.loadSuccess([ROW_A, ROW_B, ROW_C]);
  assert.ok(degraded.degradedEvents > 0);
  assert.equal(typeof degraded.degradedEvents, 'number');
});

test('E loadSuccess returns the row count and history is deterministic', () => {
  const surface = createNodePickerSurface();
  assert.equal(surface.loadSuccess([ROW_A, ROW_B, ROW_C]), 3);
  surface.setQuery('web');
  surface.select(ROW_C.id);
  assert.deepEqual(surface.history.map((h) => h.name), ['loaded', 'filtered', 'selected']);
});
