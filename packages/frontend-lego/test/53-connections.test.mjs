/**
 * P2-S16 - Connections surface pilot (issue #240).
 *
 * The strangler slice for the connection inspector / connection list split
 * out of P2-S03. Connection records and the node-id vocabulary are handed
 * over - the surface never fetches a graph, issues no engine call and never
 * posts the workflow; select changes the view only, while reconnect and
 * remove-connection are declared requests with explicit results.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over connections + nodeIds, no
 *         engine call, no workflow save, secret envelope refused, closed
 *         REGION_STATES + type/action/result vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared request vocabularies (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConnectionsSurface,
  connectionsSurfaceContract,
  connectionActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  CONNECTION_STATES,
  CONNECTION_TYPES,
  CONNECTION_EMPTY_REASONS,
  CONNECTION_ACTIONS,
  CONNECTION_SELECT_RESULTS,
  CONNECTION_RECONNECT_RESULTS,
  CONNECTION_REMOVE_RESULTS,
  CONNECTION_LABELS,
  CONNECTION_A11Y,
  CONNECTION_MAX_VISIBLE_DEFAULT,
  CONNECTION_MAX_VISIBLE_HARD_MAX,
  CONNECTION_SURFACE_ID,
} from '../src/connections.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const NODE_IDS = ['trigger', 'filter', 'set', 'slack'];
const CONNECTIONS = [
  { id: 'c1', source: { node: 'trigger', port: 0 }, target: { node: 'filter', port: 0 }, type: 'main' },
  { id: 'c2', source: { node: 'filter', port: 0 }, target: { node: 'set', port: 0 }, type: 'main' },
  { id: 'c3', source: { node: 'set', port: 0 }, target: { node: 'slack', port: 0 }, type: 'main' },
  { id: 'c4', source: { node: 'trigger', port: 1 }, target: { node: 'slack', port: 0 }, type: 'ai_tool' },
];

const recordsOf = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, source, target, type }) => ({ id, source, target, type })),
);

function loadedSurface(connections = CONNECTIONS, nodeIds = NODE_IDS, options = {}) {
  const surface = createConnectionsSurface(options);
  surface.loadSuccess({ connections, nodeIds });
  return surface;
}

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no engine call and no save', () => {
  const contract = connectionsSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, CONNECTION_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.connectionTypes, CONNECTION_TYPES);
  assert.deepEqual(contract.vocabularies.actions, CONNECTION_ACTIONS);
  assert.deepEqual(contract.vocabularies.selectResults, CONNECTION_SELECT_RESULTS);
  assert.deepEqual(contract.vocabularies.reconnectResults, CONNECTION_RECONNECT_RESULTS);
  assert.deepEqual(contract.vocabularies.removeResults, CONNECTION_REMOVE_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, CONNECTION_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, CONNECTION_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, CONNECTION_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(CONNECTION_STATES, REGION_STATES);
  assert.deepEqual(CONNECTION_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(CONNECTION_TYPES, ['main', 'ai_tool', 'ai_memory', 'ai_embedding', 'ai_vector']);
  for (const vocab of [CONNECTION_TYPES, CONNECTION_ACTIONS, CONNECTION_SELECT_RESULTS, CONNECTION_RECONNECT_RESULTS, CONNECTION_REMOVE_RESULTS, CONNECTION_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createConnectionsSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({ connections: [] }), /must have exactly connections,nodeIds/);
  assert.throws(() => surface.loadSuccess({ connections: [], nodeIds: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ connections: 'no', nodeIds: [] }), /connections \(array\) and nodeIds \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ connections: [{ id: 'x', source: { node: 'a', port: 0 }, target: { node: 'b', port: 0 }, type: 'main', token: 'x' }], nodeIds: ['a', 'b'] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ connections: [], nodeIds: [], credentials: {} }),
    /secret-bearing field credentials/,
  );
});

test('A connection records are a closed shape: exact keys, unique ids, integer ports, consistent endpoints', () => {
  const surface = createConnectionsSurface();
  assert.throws(() => surface.loadSuccess({ connections: ['x'], nodeIds: [] }), /must be an object/);
  assert.throws(
    () => surface.loadSuccess({ connections: [{ id: 'a', source: { node: 'x', port: 0 }, target: { node: 'x', port: 0 }, type: 'main', enabled: true }], nodeIds: ['x'] }),
    /must have exactly id,source,target,type/,
  );
  assert.throws(
    () => surface.loadSuccess({ connections: [{ id: '', source: { node: 'x', port: 0 }, target: { node: 'x', port: 0 }, type: 'main' }], nodeIds: ['x'] }),
    /field id must be a non-empty string/,
  );
  assert.throws(
    () => surface.loadSuccess({ connections: [{ id: 'a', source: { node: 'x', port: 0 }, target: { node: 'x', port: 0 }, type: 'sequence' }], nodeIds: ['x'] }),
    /field type must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess({ connections: [{ id: 'a', source: { node: 'x', port: -1 }, target: { node: 'x', port: 0 }, type: 'main' }], nodeIds: ['x'] }),
    /port must be a non-negative integer/,
  );
  assert.throws(
    () => surface.loadSuccess({ connections: [{ id: 'a', source: { node: 'x' }, target: { node: 'x', port: 0 }, type: 'main' }], nodeIds: ['x'] }),
    /must have exactly node,port/,
  );
  const two = [
    { id: 'a', source: { node: 'x', port: 0 }, target: { node: 'x', port: 0 }, type: 'main' },
    { id: 'a', source: { node: 'x', port: 0 }, target: { node: 'x', port: 0 }, type: 'main' },
  ];
  assert.throws(() => surface.loadSuccess({ connections: two, nodeIds: ['x'] }), /repeats the id/);
  // hand-over consistency: every endpoint resolves against the node vocabulary
  assert.throws(
    () => surface.loadSuccess({ connections: [{ id: 'a', source: { node: 'ghost', port: 0 }, target: { node: 'x', port: 0 }, type: 'main' }], nodeIds: ['x'] }),
    /unknown node "ghost"/,
  );
  assert.throws(
    () => surface.loadSuccess({ connections: [], nodeIds: ['x', 'x'] }),
    /nodeIds repeats "x"/,
  );
  assert.throws(() => surface.loadSuccess({ connections: [], nodeIds: [' '] }), /nodeIds\[0\] must be a non-empty string/);
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch, no evaluator, no save', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'connections.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches a graph');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('eval('), false, 'there is no evaluator in this surface');
  assert.equal(code.includes('new Function'), false, 'there is no function constructor in this surface');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  const assigns = code.match(/connections = Object\.freeze\(payload\.connections/g) ?? [];
  assert.equal(assigns.length, 1, 'the handed-over connections are installed in loadSuccess exactly once');
  const nodeAssigns = code.match(/nodeIds = Object\.freeze\(\[\.\.\.payload\.nodeIds\]\)/g) ?? [];
  assert.equal(nodeAssigns.length, 1, 'the handed-over node vocabulary is installed in loadSuccess exactly once');
});

test('A declared interactions never mutate the handed-over connection list', () => {
  const surface = loadedSurface();
  const before = recordsOf(surface);
  assert.equal(surface.selectConnection('c2'), 'accepted');
  assert.equal(surface.reconnect('c1', { target: { node: 'set', port: 0 } }), 'accepted');
  assert.equal(surface.removeConnection('c3'), 'accepted');
  const after = recordsOf(surface);
  assert.equal(after, before, 'the connection records are byte-identical after every interaction');
  assert.equal(surface.selectedId, 'c2', 'selection is view state, not graph data');
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.editor.connections');
  assert.ok(entry, 'ui.editor.connections is registered');
  assert.deepEqual(entry.surfaceIds, ['connections']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S16');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/53-connections.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the connections capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'connections');
  assert.ok(capability, 'connections capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/connections.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'connections');
  assert.deepEqual(capability.surfaces, ['connections']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n connection'), 'fallback keeps the reference connection list');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/53-connections.test.mjs']);
  assert.equal(capability.phase, 'P2-S16');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createConnectionsSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createConnectionsSurface();
  empty.loadSuccess({ connections: [], nodeIds: ['a'] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createConnectionsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, removeConnection: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: list landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(CONNECTION_A11Y.ready, { role: 'list', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(CONNECTION_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(CONNECTION_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(CONNECTION_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), CONNECTION_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createConnectionsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), CONNECTION_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['conn:c1', 'conn:c2', 'conn:c3', 'conn:c4'],
    'every visible connection is reachable in handed-over order; selection never reorders',
  );
  assert.equal(surface.selectConnection('c3'), 'accepted');
  model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['conn:c1', 'conn:c2', 'conn:c3', 'conn:c4'],
    'selection does not reorder the focus path',
  );
  for (const key of ['connection', 'select', 'reconnect', 'remove', 'refresh']) {
    assert.equal(typeof CONNECTION_LABELS[key], 'string');
    assert.ok(CONNECTION_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, CONNECTION_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'c3', 'the change announces the selected connection');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(connectionActionsFor('loading'), []);
  assert.deepEqual(connectionActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(connectionActionsFor('empty'), ['refresh']);
  assert.deepEqual(connectionActionsFor('ready'), ['refresh', 'select-connection', 'reconnect', 'remove-connection']);

  const loading = createConnectionsSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createConnectionsSurface();
  empty.loadSuccess({ connections: [], nodeIds: ['a'] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'a connectionless workflow offers only refresh');
  const failed = createConnectionsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded visible list: default cap, hard clamp and truncation reported', () => {
  const connections = Array.from({ length: 60 }, (_, i) => ({
    id: `conn-${i}`,
    source: { node: 'trigger', port: 0 },
    target: { node: 'filter', port: 0 },
    type: 'main',
  }));
  const surface = loadedSurface(connections, ['trigger', 'filter']);
  assert.equal(surface.maxVisible, CONNECTION_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, CONNECTION_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createConnectionsSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, CONNECTION_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createConnectionsSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createConnectionsSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const connections = Array.from({ length: 300 }, (_, i) => ({
    id: `conn-${i}`,
    source: { node: 'trigger', port: i % 4 },
    target: { node: 'filter', port: i % 2 },
    type: 'main',
  }));
  const surface = createConnectionsSurface({ maxVisible: CONNECTION_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ connections, nodeIds: ['trigger', 'filter'] });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `300 connections x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createConnectionsSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ connections: CONNECTIONS, nodeIds: NODE_IDS });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(CONNECTIONS, NODE_IDS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.selectConnection('c1');
  assert.equal(surface.degradedEvents, 2, 'the select counted');
  surface.reconnect('c1', { target: { node: 'set', port: 0 } });
  assert.equal(surface.degradedEvents, 3, 'the reconnect request counted');
  surface.removeConnection('c2');
  assert.equal(surface.degradedEvents, 4, 'the remove request counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createConnectionsSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never write the workflow', () => {
  const surface = loadedSurface();
  const before = recordsOf(surface);
  // select: view-only, explicit results
  assert.equal(surface.selectConnection('ghost'), 'unknown-connection');
  assert.equal(surface.selectConnection('c1'), 'accepted');
  assert.equal(surface.selectConnection('c1'), 'accepted', 're-selecting is idempotent');
  // reconnect: endpoint vocabulary + duplicate refusal
  assert.equal(surface.reconnect('ghost', { target: { node: 'set', port: 0 } }), 'unknown-connection');
  assert.equal(surface.reconnect('c2', { target: { node: 'ghost', port: 0 } }), 'unknown-node');
  assert.equal(
    surface.reconnect('c1', { source: { node: 'filter', port: 0 }, target: { node: 'set', port: 0 } }),
    'duplicate-connection',
    'an exact duplicate of c2 is refused',
  );
  assert.equal(surface.reconnect('c1', { target: { node: 'slack', port: 1 } }), 'accepted');
  // remove: explicit results
  assert.equal(surface.removeConnection('ghost'), 'unknown-connection');
  assert.equal(surface.removeConnection('c4'), 'accepted');
  // nothing reached the workflow document: the list is byte-identical
  assert.equal(recordsOf(surface), before, 'the hand-over survives every declared request');
  // malformed arguments are programmer errors, not domain results
  assert.throws(() => surface.selectConnection(' '), /non-empty connection id/);
  assert.throws(() => surface.reconnect('c1'), /source and\/or target/);
  assert.throws(() => surface.reconnect('c1', { nope: 1 }), /expects only source and\/or target/);
  assert.throws(() => surface.removeConnection(' '), /non-empty connection id/);
  // not-ready while loading
  surface.setLoading();
  assert.equal(surface.selectConnection('c1'), 'not-ready');
  assert.equal(surface.reconnect('c1', { target: { node: 'set', port: 0 } }), 'not-ready');
  assert.equal(surface.removeConnection('c1'), 'not-ready');
  surface.loadSuccess({ connections: [], nodeIds: NODE_IDS });
  assert.equal(surface.displayModel().reason, 'none', 'a connectionless workflow is empty with reason none');
  assert.ok(CONNECTION_SELECT_RESULTS.includes('not-ready'));
  assert.ok(CONNECTION_RECONNECT_RESULTS.includes('duplicate-connection'));
  assert.ok(CONNECTION_REMOVE_RESULTS.includes('accepted'));
  for (const action of surface.displayModel().actions) assert.ok(CONNECTION_ACTIONS.includes(action));
});
