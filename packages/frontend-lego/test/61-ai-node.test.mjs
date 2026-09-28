/**
 * P2-S24 - AI Node surfaces pilot (issue #240, Layer 5).
 *
 * The strangler slice for the AI-node parameter and model-picker surfaces
 * split out of P2-S03. The model catalog is handed over from the node/
 * parameter contracts - the surface holds no second source of truth: no
 * fetch, no catalog mutation, no local write of the selected model.
 * request-select-model is declared with explicit results, and the new value
 * arrives only via a fresh hand-over.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {models, selectedModelId},
 *         no fetch, no workflow save, secret envelope refused, closed
 *         REGION_STATES + provider/action/result vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared request vocabularies, records never mutate (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAiNodeSurface,
  aiNodeSurfaceContract,
  aiNodeActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  AI_NODE_STATES,
  MODEL_PROVIDERS,
  AI_NODE_EMPTY_REASONS,
  AI_NODE_ACTIONS,
  AI_NODE_SELECT_RESULTS,
  AI_NODE_LABELS,
  AI_NODE_A11Y,
  AI_NODE_MAX_VISIBLE_DEFAULT,
  AI_NODE_MAX_VISIBLE_HARD_MAX,
  AI_NODE_SURFACE_ID,
} from '../src/ai-node.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const MODELS = [
  { id: 'm-fast', name: 'Fast hosted model', provider: 'hosted' },
  { id: 'm-local', name: 'Local model', provider: 'local' },
  { id: 'm-custom', name: 'Custom endpoint', provider: 'custom' },
];

function loadedSurface(models = MODELS, selectedModelId = null, options = {}) {
  const surface = createAiNodeSurface(options);
  surface.loadSuccess({ models, selectedModelId });
  return surface;
}

const catalogSnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, name, provider }) => ({ id, name, provider })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = aiNodeSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, AI_NODE_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.providers, MODEL_PROVIDERS);
  assert.deepEqual(contract.vocabularies.actions, AI_NODE_ACTIONS);
  assert.deepEqual(contract.vocabularies.selectResults, AI_NODE_SELECT_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, AI_NODE_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, AI_NODE_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, AI_NODE_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(AI_NODE_STATES, REGION_STATES);
  assert.deepEqual(AI_NODE_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(MODEL_PROVIDERS, ['hosted', 'local', 'custom']);
  for (const vocab of [MODEL_PROVIDERS, AI_NODE_ACTIONS, AI_NODE_SELECT_RESULTS, AI_NODE_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createAiNodeSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly models,selectedModelId/);
  assert.throws(() => surface.loadSuccess({ models: [], selectedModelId: null, extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ models: 'no', selectedModelId: null }), /models \(array\)/);
  assert.throws(() => surface.loadSuccess({ models: [] }), /must have exactly models,selectedModelId/);
  assert.throws(
    () => surface.loadSuccess({ models: [{ id: 'm', name: 'N', provider: 'hosted', token: 'x' }], selectedModelId: null }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ models: [], selectedModelId: null, sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createAiNodeSurface();
  assert.throws(() => surface.loadSuccess({ models: ['m'], selectedModelId: null }), /model 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ models: [{ id: 'm', name: 'N', provider: 'hosted', extra: 1 }], selectedModelId: null }),
    /must have exactly id,name,provider/,
  );
  assert.throws(
    () => surface.loadSuccess({ models: [{ id: 'm', name: 'N', provider: 'mystery' }], selectedModelId: null }),
    /field provider must be one of hosted, local, custom/,
  );
  assert.throws(
    () => surface.loadSuccess({ models: [{ id: 'm', name: 'N', provider: 'hosted' }, { id: 'm', name: 'N2', provider: 'local' }], selectedModelId: null }),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess({ models: MODELS, selectedModelId: 'm-ghost' }),
    /selectedModelId must name a handed-over model/,
  );
  assert.throws(
    () => surface.loadSuccess({ models: [], selectedModelId: 42 }),
    /selectedModelId must be null or a model id/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch, no evaluator, no capability call', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'ai-node.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('eval('), false, 'there is no evaluator in this surface');
  assert.equal(code.includes('new Function'), false, 'there is no function constructor in this surface');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  assert.equal(code.includes('child_process'), false, 'the surface never shells out');
  assert.equal(code.includes('import('), false, 'the surface never dynamically imports a driver');
  const installs = code.match(/models = Object\.freeze\(payload\.models/g) ?? [];
  assert.equal(installs.length, 1, 'the catalog is installed in loadSuccess exactly once');
  // selectedModelId is assigned exactly twice in the whole module: the
  // declaration (let ... = null) and the loadSuccess install - nowhere else.
  assert.equal((code.match(/selectedModelId = /g) ?? []).length, 2, 'selectedModelId is only declared and installed in loadSuccess');
  assert.equal((code.match(/selectedModelId = payload\.selectedModelId/g) ?? []).length, 1, 'the value installs exactly once in loadSuccess');
  const fieldWrites = code.match(/\.(name|provider)\s*=(?!=)/g) ?? [];
  assert.equal(fieldWrites.length, 0, 'no model field is ever written locally - only a fresh hand-over changes the catalog');
});

test('A the declared request never moves the selection - the outcome arrives only as a fresh hand-over', () => {
  const surface = loadedSurface(MODELS, 'm-fast');
  const before = catalogSnapshot(surface);
  assert.equal(surface.requestSelectModel('m-local'), 'accepted');
  assert.equal(surface.selectedModelId, 'm-fast', 'requesting a selection never writes it locally');
  assert.equal(catalogSnapshot(surface), before, 'id/name/provider are byte-identical after the declared request');
  // the outcome arrives as a fresh hand-over
  surface.loadSuccess({ models: MODELS, selectedModelId: 'm-local' });
  assert.equal(surface.selectedModelId, 'm-local', 'only a fresh hand-over changes the parameter value');
  assert.equal(surface.displayModel().shown.find((m) => m.id === 'm-local').selected, true);
  assert.ok(AI_NODE_SELECT_RESULTS.includes('accepted'));
  assert.ok(AI_NODE_SELECT_RESULTS.includes('unknown-model'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.ai.node');
  assert.ok(entry, 'ui.ai.node is registered');
  assert.deepEqual(entry.surfaceIds, ['ai-node']);
  assert.equal(entry.category, 'ai-surfaces');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S24');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/61-ai-node.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest carries the ai-node pilot capability and leaves the AI vocabulary declared', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'ai-node');
  assert.ok(capability, 'ai-node capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/ai-node.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'ai-node');
  assert.deepEqual(capability.surfaces, ['ai-node']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/61-ai-node.test.mjs']);
  assert.equal(capability.phase, 'P2-S24');
  // The pre-existing ai-agent-node vocabulary capability stays untouched.
  const declaredAi = manifest.capabilities.find((row) => row.id === 'ai-agent-node');
  assert.equal(declaredAi.status, 'declared', 'the AI vocabulary capability claims nothing but a declaration');
  assert.equal(declaredAi.entry, undefined, 'the AI vocabulary capability names no implementation path');
  assert.deepEqual(declaredAi.surfaces, ['node-picker', 'workflow-editor'], 'the AI vocabulary surfaces are unchanged');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createAiNodeSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createAiNodeSurface();
  empty.loadSuccess({ models: [], selectedModelId: null });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createAiNodeSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestSelectModel: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(AI_NODE_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(AI_NODE_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(AI_NODE_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(AI_NODE_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), AI_NODE_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createAiNodeSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), AI_NODE_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface(MODELS, 'm-local');
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['model:m-fast', 'model:m-local', 'model:m-custom'],
    'every model row is reachable in hand-over order, rows never reorder',
  );
  for (const key of ['select', 'refresh']) {
    assert.equal(typeof AI_NODE_LABELS[key], 'string');
    assert.ok(AI_NODE_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, AI_NODE_LABELS, 'labels are declared once');
  surface.requestSelectModel('m-fast');
  assert.equal(surface.displayModel().announcement, 'm-fast', 'the request announces the model id');
  assert.equal(model.shown.find((m) => m.id === 'm-local').selected, true, 'the handed-over selection is marked, not invented');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(aiNodeActionsFor('loading'), []);
  assert.deepEqual(aiNodeActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(aiNodeActionsFor('empty'), ['refresh']);
  assert.deepEqual(aiNodeActionsFor('ready'), ['refresh', 'request-select-model']);

  const loading = createAiNodeSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createAiNodeSurface();
  empty.loadSuccess({ models: [], selectedModelId: null });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty catalog offers only refresh');
  const failed = createAiNodeSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded model list: default cap, hard clamp and truncation reported', () => {
  const models = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}`, provider: MODEL_PROVIDERS[i % 3] }));
  const surface = loadedSurface(models);
  assert.equal(surface.maxVisible, AI_NODE_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, AI_NODE_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createAiNodeSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, AI_NODE_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createAiNodeSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createAiNodeSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const models = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}`, provider: MODEL_PROVIDERS[i % 3] }));
  const surface = createAiNodeSurface({ maxVisible: AI_NODE_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ models, selectedModelId: null });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 models x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createAiNodeSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ models: MODELS, selectedModelId: null });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(MODELS, null, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestSelectModel('m-fast');
  assert.equal(surface.degradedEvents, 2, 'the select counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createAiNodeSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface(MODELS, 'm-fast');
  const before = catalogSnapshot(surface);
  // request-select-model: closed vocabulary
  assert.equal(surface.requestSelectModel('m-ghost'), 'unknown-model');
  assert.equal(surface.requestSelectModel('m-custom'), 'accepted');
  assert.equal(surface.requestSelectModel('m-fast'), 'accepted', 're-selecting the current model is still a declared request');
  assert.throws(() => surface.requestSelectModel(' '), /non-empty model id/);
  // not-ready beyond refresh
  surface.setLoading();
  assert.equal(surface.requestSelectModel('m-fast'), 'not-ready');
  // fresh hand-over replaces the view wholesale; records stay byte-identical
  surface.loadSuccess({ models: MODELS, selectedModelId: 'm-fast' });
  assert.equal(catalogSnapshot(surface), before, 'id/name/provider are byte-identical after every declared request');
  assert.equal(surface.selectedModelId, 'm-fast');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ models: [], selectedModelId: null });
  assert.equal(surface.displayModel().reason, 'none', 'no models is empty with reason none');
  assert.equal(surface.requestSelectModel('m-fast'), 'not-ready');
  assert.ok(AI_NODE_SELECT_RESULTS.includes('unknown-model'));
  assert.ok(AI_NODE_SELECT_RESULTS.includes('not-ready'));
  for (const action of AI_NODE_ACTIONS) assert.ok(AI_NODE_ACTIONS.includes(action));
});
