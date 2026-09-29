/**
 * P2-S17 - Import/export surface pilot (issue #240).
 *
 * The strangler slice for the workflow JSON import/export flow split out of
 * P2-S03. The workflow document is handed over - the surface never fetches,
 * never posts the workflow; export serializes exactly the handed-over
 * document (round-trip semantic identity) while import parses a candidate
 * with JSON.parse, validates it and holds it PENDING for the app layer; the
 * document on screen is byte-identical after every interaction.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over workflow document, no
 *         fetch, no workflow save, secret envelope refused (hand-over AND
 *         import candidate), closed REGION_STATES + action/result
 *         vocabularies (A)
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
  createImportExportSurface,
  importExportSurfaceContract,
  ioActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  IO_STATES,
  IO_EMPTY_REASONS,
  IO_ACTIONS,
  IO_EXPORT_RESULTS,
  IO_IMPORT_RESULTS,
  IO_LABELS,
  IO_A11Y,
  IO_MAX_VISIBLE_DEFAULT,
  IO_MAX_VISIBLE_HARD_MAX,
  IO_SURFACE_ID,
} from '../src/import-export.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const WORKFLOW = {
  name: 'Demo flow',
  nodes: [
    { id: 'n1', name: 'When called', type: 'n8n-nodes-base.webhook', parameters: {} },
    { id: 'n2', name: 'Set field', type: 'n8n-nodes-base.set', parameters: { value: '={{ $json.x }}' } },
    { id: 'n3', name: 'Slack', type: 'n8n-nodes-base.slack', parameters: {} },
  ],
  connections: {
    'When called': { main: [[{ node: 'Set field', type: 'main', index: 0 }]] },
  },
  active: false,
};

function loadedSurface(workflow = WORKFLOW, options = {}) {
  const surface = createImportExportSurface(options);
  surface.loadSuccess({ workflow });
  return surface;
}

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = importExportSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, IO_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.actions, IO_ACTIONS);
  assert.deepEqual(contract.vocabularies.exportResults, IO_EXPORT_RESULTS);
  assert.deepEqual(contract.vocabularies.importResults, IO_IMPORT_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, IO_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, IO_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, IO_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(IO_STATES, REGION_STATES);
  assert.deepEqual(IO_STATES, ['loading', 'empty', 'error', 'ready']);
  for (const vocab of [IO_ACTIONS, IO_EXPORT_RESULTS, IO_IMPORT_RESULTS, IO_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createImportExportSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({ nodes: [] }), /must have exactly workflow/);
  assert.throws(() => surface.loadSuccess({ workflow: {}, extra: 1 }), /must have exactly/);
  assert.throws(
    () => surface.loadSuccess({ workflow: { nodes: [], connections: {}, token: 'x' } }),
    /secret-bearing field token/,
  );
  assert.throws(() => surface.loadSuccess({ workflow: [] }), /invalid: not a plain object/);
  assert.throws(() => surface.loadSuccess({ workflow: { connections: {} } }), /invalid: missing nodes array/);
  assert.throws(() => surface.loadSuccess({ workflow: { nodes: [] } }), /invalid: missing connections object/);
});

test('A the document never changes: export round-trips to the hand-over, imports stay pending', () => {
  const surface = loadedSurface();
  const documentView = () => {
    const model = surface.displayModel();
    return JSON.stringify({ shown: model.shown, total: model.total, reason: model.reason, visibleCount: model.visibleCount });
  };
  const before = documentView();
  assert.equal(surface.requestExport(), 'accepted');
  const json = surface.exportJson();
  assert.deepEqual(JSON.parse(json), WORKFLOW, 'the export parses back to exactly the hand-over');
  assert.equal(
    surface.importDocument('{"name":"Incoming","nodes":[],"connections":{}}'),
    'accepted',
  );
  assert.deepEqual(surface.pendingImport, { name: 'Incoming', nodes: [], connections: {} });
  assert.equal(surface.displayModel().pendingImport, true, 'the pending hand-off is visible');
  assert.equal(documentView(), before, 'the handed-over document view survives every declared request');
  assert.equal(surface.exportJson(), json, 'the workflow document is byte-identical after the import');
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch, no evaluator, no save', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'import-export.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('eval('), false, 'there is no evaluator in this surface');
  assert.equal(code.includes('new Function'), false, 'there is no function constructor in this surface');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  const assigns = code.match(/workflow = payload\.workflow/g) ?? [];
  assert.equal(assigns.length, 1, 'the handed-over document is installed in loadSuccess exactly once');
  assert.equal(code.includes('JSON.parse(text)'), true, 'import parses the candidate with JSON.parse only');
});

test('A workflow JSON semantics survive verbatim: unknown keys pass through untouched', () => {
  const surface = loadedSurface();
  const candidate = {
    name: 'Compat',
    nodes: [{ id: 'n1', name: 'A', type: 'x', parameters: { keep: '={{ $json.raw }}' } }],
    connections: { A: { main: [[]] } },
    // keys the pilot does not know about must survive the round-trip
    meta: { instanceId: 'x' },
    tags: [{ id: 1 }],
    active: true,
    customFlag: 42,
  };
  assert.equal(surface.importDocument(JSON.stringify(candidate)), 'accepted');
  assert.deepEqual(surface.pendingImport, candidate, 'no key stripped, no value rewritten');
  assert.equal(surface.requestExport(), 'accepted');
  assert.deepEqual(JSON.parse(surface.exportJson()), WORKFLOW, 'the export side still carries exactly the hand-over');
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.io.import-export');
  assert.ok(entry, 'ui.io.import-export is registered');
  assert.deepEqual(entry.surfaceIds, ['workflow-editor', 'dashboard']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S17');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/54-import-export.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the import-export capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'import-export');
  assert.ok(capability, 'import-export capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/import-export.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'import-export');
  assert.deepEqual(capability.surfaces, ['workflow-editor', 'dashboard']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n import/export'), 'fallback keeps the reference flow');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/54-import-export.test.mjs']);
  assert.equal(capability.phase, 'P2-S17');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createImportExportSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createImportExportSurface();
  empty.loadSuccess({ workflow: { name: 'Empty', nodes: [], connections: {} } });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createImportExportSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, importDocument: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(IO_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(IO_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(IO_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(IO_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), IO_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createImportExportSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), IO_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['export', 'import'],
    'both controls are reachable in a stable order',
  );
  assert.equal(surface.importDocument('{"name":"Loaded name","nodes":[],"connections":{}}'), 'accepted');
  model = surface.displayModel();
  assert.deepEqual(model.focusOrder, ['export', 'import'], 'an import never reorders the focus path');
  for (const key of ['export', 'import', 'refresh']) {
    assert.equal(typeof IO_LABELS[key], 'string');
    assert.ok(IO_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, IO_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'Loaded name', 'the change announces the imported workflow name');
  const loading = createImportExportSurface();
  assert.deepEqual(loading.displayModel().focusOrder, [], 'loading exposes no controls');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(ioActionsFor('loading'), []);
  assert.deepEqual(ioActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(ioActionsFor('empty'), ['refresh'], 'the empty region offers only refresh (recorded as evidence)');
  assert.deepEqual(ioActionsFor('ready'), ['refresh', 'request-export', 'import-document']);

  const loading = createImportExportSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createImportExportSurface();
  empty.loadSuccess({ workflow: { name: 'Empty', nodes: [], connections: {} } });
  assert.deepEqual(empty.displayModel().actions, ['refresh']);
  assert.equal(empty.requestExport(), 'not-ready', 'the empty region does not offer export');
  assert.equal(empty.importDocument('{"nodes":[],"connections":{}}'), 'not-ready');
  const failed = createImportExportSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded node preview: default cap, hard clamp and truncation reported', () => {
  const workflow = {
    name: 'Wide',
    nodes: Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, name: `Node ${i}`, type: 'x', parameters: {} })),
    connections: {},
  };
  const surface = loadedSurface(workflow);
  assert.equal(surface.maxVisible, IO_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, IO_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createImportExportSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, IO_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createImportExportSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createImportExportSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const workflow = {
    name: 'Big',
    nodes: Array.from({ length: 300 }, (_, i) => ({ id: `n${i}`, name: `Node number ${i}`, type: 'x', parameters: {} })),
    connections: {},
  };
  const surface = createImportExportSurface({ maxVisible: IO_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ workflow });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `300 nodes x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createImportExportSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ workflow: WORKFLOW });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(WORKFLOW, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestExport();
  assert.equal(surface.degradedEvents, 2, 'the export request counted');
  surface.importDocument('{"nodes":[],"connections":{}}');
  assert.equal(surface.degradedEvents, 3, 'the import request counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createImportExportSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never write the workflow', () => {
  const surface = loadedSurface();
  const documentBefore = surface.exportJson();
  // export: explicit results, exact content
  assert.equal(surface.requestExport(), 'accepted');
  assert.deepEqual(JSON.parse(surface.exportJson()), WORKFLOW);
  // import: parse + validate, pass-through, pending hand-off only
  assert.equal(surface.importDocument('{"broken'), 'invalid-json');
  assert.equal(surface.importDocument('[1,2,3]'), 'invalid-document', 'an array is not a document');
  assert.equal(surface.importDocument('null'), 'invalid-document');
  assert.equal(surface.importDocument('{"name":"No nodes"}'), 'invalid-document', 'nodes+connections are required');
  assert.equal(surface.importDocument('{"nodes":[],"connections":[1]}'), 'invalid-document', 'connections must be an object');
  assert.throws(
    () => surface.importDocument('{"token":"x","nodes":[],"connections":{}}'),
    /secret-bearing field token/,
    'a secret-bearing candidate is refused with an explicit security error',
  );
  assert.equal(surface.importDocument('{"name":"Loaded name","nodes":[],"connections":{}}'), 'accepted');
  // the workflow document on screen is untouched by every declared request
  assert.equal(surface.exportJson(), documentBefore, 'the hand-over survives every declared request');
  // not-ready while loading
  surface.setLoading();
  assert.equal(surface.requestExport(), 'not-ready');
  assert.equal(surface.importDocument('{"nodes":[],"connections":{}}'), 'not-ready');
  // malformed arguments are programmer errors, not domain results
  assert.throws(() => surface.importDocument({}), /as a string/);
  const fresh = createImportExportSurface();
  assert.throws(() => fresh.exportJson(), /before loadSuccess/);
  assert.ok(IO_EXPORT_RESULTS.includes('not-ready'));
  assert.ok(IO_IMPORT_RESULTS.includes('invalid-json'));
  assert.ok(IO_IMPORT_RESULTS.includes('invalid-document'));
  for (const action of surface.displayModel().actions) assert.ok(IO_ACTIONS.includes(action));
});
