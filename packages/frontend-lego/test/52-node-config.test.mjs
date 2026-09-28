/**
 * P2-S15 - Node configuration surface pilot (issue #240).
 *
 * The strangler slice for the node parameter / NDV panel split out of P2-S03.
 * Parameter definitions and values are handed over - the surface never
 * fetches a schema, evaluates no expression (strings pass through verbatim)
 * and never posts the workflow; setParameter/requestSubmit are declared
 * interactions with explicit results.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over definitions + values, no
 *         expression evaluation, no workflow save, secret envelope refused,
 *         closed REGION_STATES + type/value-kind vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared requests (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createNodeConfigSurface,
  nodeConfigSurfaceContract,
  paramActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  PARAM_STATES,
  PARAM_TYPES,
  PARAM_VALUE_KINDS,
  PARAM_EMPTY_REASONS,
  PARAM_ACTIONS,
  PARAM_SET_RESULTS,
  PARAM_SUBMIT_RESULTS,
  PARAM_LABELS,
  PARAM_A11Y,
  PARAM_MAX_VISIBLE_DEFAULT,
  PARAM_MAX_VISIBLE_HARD_MAX,
  PARAM_SURFACE_ID,
} from '../src/node-config.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const TEXT = { displayName: 'Text', name: 'text', options: null, required: false, type: 'string' };
const COUNT = { displayName: 'Count', name: 'count', options: null, required: true, type: 'number' };
const FLAG = { displayName: 'Enabled', name: 'enabled', options: null, required: false, type: 'boolean' };
const MODE = {
  displayName: 'Mode', name: 'mode', required: false, type: 'options',
  options: [{ name: 'Append', value: 'append' }, { name: 'Replace', value: 'replace' }],
};

const PARAMETERS = [TEXT, COUNT, FLAG, MODE];
const VALUES = { text: 'hello', count: 3, enabled: true, mode: 'append' };

function loadedSurface(parameters = PARAMETERS, values = VALUES, options = {}) {
  const surface = createNodeConfigSurface(options);
  surface.loadSuccess({ parameters, values });
  return surface;
}

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no evaluator and no save', () => {
  const contract = nodeConfigSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesExpressionEvaluation: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, PARAM_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.parameterTypes, PARAM_TYPES);
  assert.deepEqual(contract.vocabularies.valueKinds, PARAM_VALUE_KINDS);
  assert.deepEqual(contract.vocabularies.actions, PARAM_ACTIONS);
  assert.deepEqual(contract.vocabularies.setResults, PARAM_SET_RESULTS);
  assert.deepEqual(contract.vocabularies.submitResults, PARAM_SUBMIT_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, PARAM_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, PARAM_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, PARAM_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(PARAM_STATES, REGION_STATES);
  assert.deepEqual(PARAM_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(PARAM_TYPES, ['string', 'number', 'boolean', 'options']);
  assert.deepEqual(PARAM_VALUE_KINDS, ['literal', 'expression', 'unset']);
  for (const vocab of [PARAM_TYPES, PARAM_VALUE_KINDS, PARAM_ACTIONS, PARAM_SET_RESULTS, PARAM_SUBMIT_RESULTS, PARAM_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createNodeConfigSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({ parameters: [] }), /must have exactly parameters,values/);
  assert.throws(() => surface.loadSuccess({ parameters: [], values: {}, extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ parameters: 'no', values: {} }), /parameters \(array\) and values \(object\)/);
  // a values key the definitions do not know is refused (empty table -> unknown parameter)
  assert.throws(() => surface.loadSuccess({ parameters: [], values: { token: 'x' } }), /unknown parameter "token"/);
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ ...TEXT, password: 'x' }], values: {} }),
    /secret-bearing field password/,
  );
});

test('A definitions are a closed shape: exact keys, closed types, unique names, consistent values', () => {
  const surface = createNodeConfigSurface();
  assert.throws(() => surface.loadSuccess({ parameters: ['not-an-object'], values: {} }), /must be an object/);
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ name: 'x', displayName: 'X', type: 'string', required: false }], values: {} }),
    /must have exactly displayName,name,options,required,type/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ ...TEXT, extra: 1 }], values: {} }),
    /must have exactly/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ ...TEXT, type: 'collection' }], values: {} }),
    /field type must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ ...TEXT, name: ' ' }], values: {} }),
    /non-empty string/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ ...TEXT, options: [{ name: 'a', value: 'b' }] }], values: {} }),
    /options only for type options/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ ...MODE, options: [] }], values: {} }),
    /non-empty options list/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [{ ...MODE, options: [{ label: 'a' }] }], values: {} }),
    /exactly name,value/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [TEXT, { ...TEXT }], values: {} }),
    /repeats the name/,
  );
  // hand-over consistency: values must name known parameters and be primitives
  assert.throws(
    () => surface.loadSuccess({ parameters: [TEXT], values: { ghost: 'x' } }),
    /unknown parameter "ghost"/,
  );
  assert.throws(
    () => surface.loadSuccess({ parameters: [TEXT], values: { text: { nested: 1 } } }),
    /must be a primitive/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no evaluator, no save, no fetch', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'node-config.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('eval('), false, 'there is no evaluator in this surface');
  assert.equal(code.includes('new Function'), false, 'there is no function constructor in this surface');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  const assigns = code.match(/parameters = Object\.freeze\(payload\.parameters/g) ?? [];
  assert.equal(assigns.length, 1, 'the handed-over definitions are installed in loadSuccess exactly once');
  const valueAssigns = code.match(/values = Object\.freeze\(mutable\)/g) ?? [];
  assert.equal(valueAssigns.length, 1, 'the handed-over values are installed in loadSuccess exactly once');
});

test('A an expression passes through verbatim and is marked - never evaluated', () => {
  const surface = loadedSurface();
  const expression = '={{ $json.message.toUpperCase() }}';
  assert.equal(surface.setParameter('text', expression), 'accepted');
  const model = surface.displayModel();
  const row = model.shown.find((entry) => entry.name === 'text');
  assert.equal(row.value, expression, 'the expression string is exactly what the hand-over carried');
  assert.equal(row.valueKind, 'expression', 'marked, not executed');
  // no evaluation happened: the raw text of the expression is untouched, and
  // setting the same expression again is idempotent
  assert.equal(surface.setParameter('text', expression), 'accepted');
  const literal = model.shown.find((entry) => entry.name === 'count');
  assert.equal(literal.valueKind, 'literal');
  const unset = loadedSurface(PARAMETERS, { ...VALUES, count: null });
  assert.equal(unset.displayModel().shown.find((entry) => entry.name === 'count').valueKind, 'unset');
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.nodes.parameters');
  assert.ok(entry, 'ui.nodes.parameters is registered');
  assert.deepEqual(entry.surfaceIds, ['node-config']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S15');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/52-node-config.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the node-config capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'node-config');
  assert.ok(capability, 'node-config capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/node-config.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'node-config');
  assert.deepEqual(capability.surfaces, ['node-config']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n parameter panel'), 'fallback keeps the reference panel');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/52-node-config.test.mjs']);
  assert.equal(capability.phase, 'P2-S15');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createNodeConfigSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createNodeConfigSurface();
  empty.loadSuccess({ parameters: [], values: {} });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createNodeConfigSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, setParameter: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(PARAM_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(PARAM_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(PARAM_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(PARAM_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), PARAM_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createNodeConfigSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), PARAM_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['param:text', 'param:count', 'param:enabled', 'param:mode'],
    'every visible parameter is reachable in definition order; submit appears only while dirty',
  );
  assert.equal(surface.setParameter('count', 7), 'accepted');
  model = surface.displayModel();
  assert.equal(model.focusOrder.at(-1), 'submit', 'applying changes is reachable after the parameters');
  for (const key of ['parameter', 'submit', 'refresh']) {
    assert.equal(typeof PARAM_LABELS[key], 'string');
    assert.ok(PARAM_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, PARAM_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'Count', 'the change announces the parameter display name');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(paramActionsFor('loading'), []);
  assert.deepEqual(paramActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(paramActionsFor('empty'), ['refresh']);
  assert.deepEqual(paramActionsFor('ready'), ['refresh', 'set-parameter', 'request-submit']);

  const loading = createNodeConfigSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createNodeConfigSurface();
  empty.loadSuccess({ parameters: [], values: {} });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'a parameterless node offers only refresh');
  const failed = createNodeConfigSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded visible list: default cap, hard clamp and truncation reported', () => {
  const parameters = Array.from({ length: 60 }, (_, i) => ({
    displayName: `Parameter ${i}`, name: `p${i}`, options: null, required: false, type: 'string',
  }));
  const values = Object.fromEntries(parameters.map((definition) => [definition.name, 'x']));
  const surface = loadedSurface(parameters, values);
  assert.equal(surface.maxVisible, PARAM_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, PARAM_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createNodeConfigSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, PARAM_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createNodeConfigSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createNodeConfigSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const parameters = Array.from({ length: 200 }, (_, i) => ({
    displayName: `Parameter number ${i}`, name: `p${i}`, options: null, required: false, type: 'string',
  }));
  const values = Object.fromEntries(parameters.map((definition, i) => [definition.name, `value ${i}`]));
  const surface = createNodeConfigSurface({ maxVisible: PARAM_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ parameters, values });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 parameters x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createNodeConfigSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ parameters: PARAMETERS, values: VALUES });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(PARAMETERS, VALUES, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.setParameter('count', 9);
  assert.equal(surface.degradedEvents, 2, 'the set counted');
  surface.requestSubmit();
  assert.equal(surface.degradedEvents, 3, 'the submit counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createNodeConfigSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies; typing is checked against the handed-over type', () => {
  const surface = loadedSurface();
  assert.equal(surface.setParameter('ghost', 'x'), 'unknown-parameter');
  assert.equal(surface.setParameter('count', 'not-a-number'), 'invalid-value');
  assert.equal(surface.setParameter('enabled', 1), 'invalid-value');
  assert.equal(surface.setParameter('mode', 'unknown-option'), 'invalid-value');
  assert.equal(surface.setParameter('mode', 'replace'), 'accepted');
  assert.equal(surface.setParameter('count', 4), 'accepted');
  assert.equal(surface.displayModel().dirty.length, 2, 'mode and count are dirty');
  assert.equal(surface.requestSubmit(), 'accepted');
  surface.setLoading();
  assert.equal(surface.setParameter('count', 5), 'not-ready');
  assert.equal(surface.requestSubmit(), 'not-ready');
  surface.loadSuccess({ parameters: PARAMETERS, values: VALUES });
  assert.equal(surface.displayModel().announcement, null, 'the hand-over clears the pending announcement');
  assert.equal(surface.displayModel().dirty.length, 0, 'the hand-over resets the dirty list');
  assert.equal(surface.requestSubmit(), 'no-changes', 'nothing to persist without a change');
  assert.throws(() => surface.setParameter('count', Number.NaN), /must be a primitive/);
  assert.throws(() => surface.setParameter(' ', 'x'), /non-empty parameter name/);
  const model = surface.displayModel();
  for (const action of model.actions) assert.ok(PARAM_ACTIONS.includes(action));
  assert.ok(PARAM_SET_RESULTS.includes('invalid-value'));
  assert.ok(PARAM_SUBMIT_RESULTS.includes('no-changes'));
});
