/**
 * P2-S14 - Canvas surface pilot (issue #240).
 *
 * The strangler slice for the workflow node-graph rendering surface (nodes,
 * edges, viewport, selection) split out of P2-S03. The graph model is handed
 * over - the surface never fetches and performs no engine call; selection and
 * zoom are declared view-state interactions, never graph mutations.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over graph model, no engine
 *         call, no engine authority, secret/engine fields refused, closed
 *         REGION_STATES + closed shapes (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         zoom bounds, declared requests (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCanvasSurface,
  canvasSurfaceContract,
  canvasActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  CANVAS_STATES,
  CANVAS_EMPTY_REASONS,
  CANVAS_ACTIONS,
  CANVAS_SELECT_RESULTS,
  CANVAS_CLEAR_RESULTS,
  CANVAS_ZOOM_RESULTS,
  CANVAS_ZOOM_MIN,
  CANVAS_ZOOM_MAX,
  CANVAS_DEFAULT_VIEWPORT,
  CANVAS_LABELS,
  CANVAS_A11Y,
  CANVAS_MAX_VISIBLE_DEFAULT,
  CANVAS_MAX_VISIBLE_HARD_MAX,
  CANVAS_SURFACE_ID,
} from '../src/canvas.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const N1 = { id: 'n1', type: 'n8n-nodes-base.manualTrigger', name: 'When clicking Execute', position: [0, 0] };
const N2 = { id: 'n2', type: 'n8n-nodes-base.set', name: 'Set a Field', position: [220, 0] };
const N3 = { id: 'n3', type: 'n8n-nodes-base.noOp', name: 'No Operation', position: [440, 0] };
const E1 = { id: 'e1', source: 'n1', target: 'n2' };
const E2 = { id: 'e2', source: 'n2', target: 'n3' };

const GRAPH = { nodes: [N1, N2, N3], edges: [E1, E2] };

function loadedSurface(graph = GRAPH, options = {}) {
  const surface = createCanvasSurface(options);
  surface.loadSuccess(graph === null ? { nodes: [], edges: [] } : graph);
  return surface;
}

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary and no engine authority', () => {
  const contract = canvasSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    ownsEngineAuthority: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, CANVAS_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.actions, CANVAS_ACTIONS);
  assert.deepEqual(contract.vocabularies.selectResults, CANVAS_SELECT_RESULTS);
  assert.deepEqual(contract.vocabularies.clearResults, CANVAS_CLEAR_RESULTS);
  assert.deepEqual(contract.vocabularies.zoomResults, CANVAS_ZOOM_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, CANVAS_EMPTY_REASONS);
  assert.deepEqual(contract.vocabularies.zoom, { min: CANVAS_ZOOM_MIN, max: CANVAS_ZOOM_MAX });
  assert.equal(contract.bounds.maxVisibleDefault, CANVAS_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, CANVAS_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(CANVAS_STATES, REGION_STATES);
  assert.deepEqual(CANVAS_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(CANVAS_EMPTY_REASONS, ['none']);
  for (const vocab of [CANVAS_ACTIONS, CANVAS_SELECT_RESULTS, CANVAS_CLEAR_RESULTS, CANVAS_ZOOM_RESULTS, CANVAS_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the graph carries no secrets or engine fields', () => {
  const surface = createCanvasSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({ nodes: [] }), /must have exactly nodes,edges/);
  assert.throws(() => surface.loadSuccess({ nodes: [], edges: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ nodes: 'no', edges: [] }), /must be arrays/);
  assert.throws(
    () => surface.loadSuccess({ nodes: [], edges: [], credentials: {} }),
    /secret-bearing or engine field credentials/,
  );
  const withSecret = [{ id: 'x', type: 't', name: 'x', position: [0, 0], token: 'x' }];
  assert.throws(() => surface.loadSuccess({ nodes: withSecret, edges: [] }), /secret-bearing or engine field token/);
  const withEngine = [{ id: 'x', type: 't', name: 'x', position: [0, 0], runData: [] }];
  assert.throws(() => surface.loadSuccess({ nodes: withEngine, edges: [] }), /secret-bearing or engine field runData/);
});

test('A graph entries are a closed shape: exact keys, finite positions, unique ids, known edge endpoints', () => {
  const surface = createCanvasSurface();
  assert.throws(() => surface.loadSuccess({ nodes: ['not-an-object'], edges: [] }), /must be an object/);
  assert.throws(
    () => surface.loadSuccess({ nodes: [{ id: 'x', type: 't', name: 'x' }], edges: [] }),
    /must have exactly id,name,position,type/,
  );
  assert.throws(
    () => surface.loadSuccess({ nodes: [{ id: 'x', type: 't', name: 'x', position: [0, 0], extra: 1 }], edges: [] }),
    /must have exactly/,
  );
  assert.throws(
    () => surface.loadSuccess({ nodes: [{ id: 'x', type: 't', name: 'x', position: ['0', 0] }], edges: [] }),
    /\[finite, finite\]/,
  );
  assert.throws(
    () => surface.loadSuccess({ nodes: [{ id: 'x', type: 't', name: ' ', position: [0, 0] }], edges: [] }),
    /non-empty string/,
  );
  assert.throws(
    () => surface.loadSuccess({ nodes: [N1, { ...N1 }], edges: [] }),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess({ nodes: [{ id: '__proto__', type: 't', name: 'x', position: [0, 0] }], edges: [] }),
    /reserved/,
  );
  assert.throws(
    () => surface.loadSuccess({ nodes: [N1], edges: [{ id: 'e', source: 'n1', target: 'ghost' }] }),
    /unknown node "ghost"/,
  );
  assert.throws(
    () => surface.loadSuccess({ nodes: [N1], edges: [{ id: 'e1', source: 'n1', target: 'n1' }, { id: 'e1', source: 'n1', target: 'n1' }] }),
    /repeats the id/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch/location/engine call', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'canvas.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  const assigns = code.match(/nodes = Object\.freeze\(payload\.nodes/g) ?? [];
  assert.equal(assigns.length, 1, 'the handed-over graph is installed in loadSuccess exactly once');
  const edgeAssigns = code.match(/edges = Object\.freeze\(payload\.edges/g) ?? [];
  assert.equal(edgeAssigns.length, 1, 'edges come from the hand-over exactly once');
});

test('A selection and zoom never mutate the graph (view state only)', () => {
  const surface = loadedSurface();
  const before = JSON.stringify(surface.displayModel().shown);
  assert.equal(surface.selectNode('n2'), 'selected');
  assert.equal(surface.setZoom(2), 'zoomed');
  assert.equal(JSON.stringify(surface.displayModel().shown), before, 'the graph is byte-identical after interactions');
  const last = surface.history.at(-1);
  assert.equal(last.name, 'zoom-changed');
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.editor.canvas');
  assert.ok(entry, 'ui.editor.canvas is registered');
  assert.deepEqual(entry.surfaceIds, ['canvas']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S14');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/51-canvas.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the canvas capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'canvas');
  assert.ok(capability, 'canvas capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/canvas.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'canvas');
  assert.deepEqual(capability.surfaces, ['canvas']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n canvas'), 'fallback keeps the reference canvas');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/51-canvas.test.mjs']);
  assert.equal(capability.phase, 'P2-S14');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createCanvasSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createCanvasSurface();
  empty.loadSuccess({ nodes: [], edges: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createCanvasSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, selectNode: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: application landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(CANVAS_A11Y.ready, { role: 'application', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(CANVAS_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(CANVAS_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(CANVAS_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), CANVAS_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createCanvasSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), CANVAS_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['node:n1', 'node:n2', 'node:n3'],
    'every visible node is reachable in graph order; clear-selection appears only once something is selected',
  );
  assert.equal(surface.selectNode('n2'), 'selected');
  model = surface.displayModel();
  assert.equal(model.focusOrder.at(-1), 'clear-selection', 'clearing the selection is reachable after the nodes');
  for (const key of ['node', 'clearSelection', 'zoom', 'refresh']) {
    assert.equal(typeof CANVAS_LABELS[key], 'string');
    assert.ok(CANVAS_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, CANVAS_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'Set a Field', 'the selection announces the node name');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(canvasActionsFor('loading'), []);
  assert.deepEqual(canvasActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(canvasActionsFor('empty'), ['refresh']);
  assert.deepEqual(canvasActionsFor('ready'), ['refresh', 'select-node', 'clear-selection', 'set-zoom']);

  const loading = createCanvasSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createCanvasSurface();
  empty.loadSuccess({ nodes: [], edges: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty graph offers only refresh');
  const failed = createCanvasSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded visible list: default cap, hard clamp and truncation reported', () => {
  const nodes = Array.from({ length: 80 }, (_, i) => ({
    id: `n${i}`, type: 'n8n-nodes-base.noOp', name: `Node ${i}`, position: [i * 20, 0],
  }));
  const surface = loadedSurface({ nodes, edges: [] });
  assert.equal(surface.maxVisible, CANVAS_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, CANVAS_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 80);

  const wide = createCanvasSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, CANVAS_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createCanvasSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createCanvasSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const nodes = Array.from({ length: 250 }, (_, i) => ({
    id: `n${i}`, type: 'n8n-nodes-base.noOp', name: `Node number ${i}`, position: [(i % 25) * 120, Math.floor(i / 25) * 90],
  }));
  const edges = Array.from({ length: 249 }, (_, i) => ({
    id: `e${i}`, source: `n${i}`, target: `n${i + 1}`,
  }));
  const surface = createCanvasSurface({ maxVisible: CANVAS_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ nodes, edges });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `250 nodes + 249 edges x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createCanvasSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess(GRAPH);
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface({ nodes: [], edges: [] }, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.setZoom(2);
  assert.equal(surface.degradedEvents, 2, 'the zoom counted');
  surface.loadSuccess(GRAPH);
  surface.selectNode('n2');
  assert.equal(surface.degradedEvents, 4, 'the re-load and the selection both counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createCanvasSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies; zoom is bounded, never silently clamped', () => {
  const surface = loadedSurface();
  assert.equal(surface.selectNode('ghost'), 'unknown-node');
  assert.equal(surface.selectNode('n2'), 'selected');
  assert.equal(surface.selectNode('n2'), 'same-node');
  assert.equal(surface.clearSelection(), 'cleared');
  assert.equal(surface.clearSelection(), 'no-selection');
  surface.setLoading();
  assert.equal(surface.selectNode('n2'), 'not-ready');
  assert.equal(surface.clearSelection(), 'not-ready');
  assert.equal(surface.setZoom(2), 'not-ready');
  surface.loadSuccess(GRAPH);
  assert.equal(surface.displayModel().announcement, null, 'the hand-over clears the pending announcement');
  // zoom bounds: explicit out-of-bounds, viewport untouched
  assert.equal(surface.setZoom(0.1), 'out-of-bounds');
  assert.equal(surface.setZoom(5), 'out-of-bounds');
  assert.equal(surface.setZoom(0.25), 'zoomed');
  assert.equal(surface.setZoom(4), 'zoomed');
  assert.equal(surface.setZoom(1), 'zoomed');
  assert.deepEqual(surface.displayModel().viewport, CANVAS_DEFAULT_VIEWPORT);
  assert.throws(() => surface.setZoom('2'), /finite number/);
  assert.throws(() => surface.selectNode(' '), /non-empty node id/);
  const model = surface.displayModel();
  for (const action of model.actions) assert.ok(CANVAS_ACTIONS.includes(action));
  assert.ok(CANVAS_SELECT_RESULTS.includes('unknown-node'));
  assert.ok(CANVAS_CLEAR_RESULTS.includes('no-selection'));
  assert.ok(CANVAS_ZOOM_RESULTS.includes('out-of-bounds'));
});
