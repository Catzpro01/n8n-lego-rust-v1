/**
 * P2-S18 - Environments surface pilot (issue #240, Layer 4).
 *
 * The strangler slice for the environment selection and variable-scoping
 * panel split out of P2-S03. Environments, the active id and the variable
 * records are handed over - the surface never fetches, never derives the
 * active environment locally and never persists; set-variable/set-scope/
 * request-submit/request-switch are declared interactions with explicit
 * results.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {environments, active,
 *         variables}, no fetch, no workflow save, secret envelope refused,
 *         closed REGION_STATES + kind/scope/action/result vocabularies (A)
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
  createEnvironmentsSurface,
  environmentsSurfaceContract,
  envActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  ENV_STATES,
  ENV_KINDS,
  ENV_GLOBAL_SCOPE,
  ENV_EMPTY_REASONS,
  ENV_ACTIONS,
  ENV_SET_RESULTS,
  ENV_SCOPE_RESULTS,
  ENV_SUBMIT_RESULTS,
  ENV_SWITCH_RESULTS,
  ENV_LABELS,
  ENV_A11Y,
  ENV_MAX_VISIBLE_DEFAULT,
  ENV_MAX_VISIBLE_HARD_MAX,
  ENV_SURFACE_ID,
} from '../src/environments.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const ENVIRONMENTS = [
  { id: 'e-dev', name: 'Development', kind: 'dev' },
  { id: 'e-prev', name: 'Preview', kind: 'preview' },
  { id: 'e-stg', name: 'Staging', kind: 'staging' },
];
const VARIABLES = [
  { name: 'API_URL', value: 'https://example.test', scope: ENV_GLOBAL_SCOPE },
  { name: 'RETRIES', value: 3, scope: 'e-dev' },
  { name: 'FEATURE_X', value: true, scope: 'e-stg' },
  { name: 'EMPTY', value: null, scope: 'e-dev' },
];

function loadedSurface(environments = ENVIRONMENTS, active = 'e-dev', variables = VARIABLES, options = {}) {
  const surface = createEnvironmentsSurface(options);
  surface.loadSuccess({ environments, active, variables });
  return surface;
}

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = environmentsSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, ENV_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.environmentKinds, ENV_KINDS);
  assert.equal(contract.vocabularies.globalScope, ENV_GLOBAL_SCOPE);
  assert.deepEqual(contract.vocabularies.actions, ENV_ACTIONS);
  assert.deepEqual(contract.vocabularies.setResults, ENV_SET_RESULTS);
  assert.deepEqual(contract.vocabularies.scopeResults, ENV_SCOPE_RESULTS);
  assert.deepEqual(contract.vocabularies.submitResults, ENV_SUBMIT_RESULTS);
  assert.deepEqual(contract.vocabularies.switchResults, ENV_SWITCH_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, ENV_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, ENV_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, ENV_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(ENV_STATES, REGION_STATES);
  assert.deepEqual(ENV_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(ENV_KINDS, ['dev', 'preview', 'staging']);
  for (const vocab of [ENV_KINDS, ENV_ACTIONS, ENV_SET_RESULTS, ENV_SCOPE_RESULTS, ENV_SUBMIT_RESULTS, ENV_SWITCH_RESULTS, ENV_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createEnvironmentsSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({ environments: [] }), /must have exactly environments,active,variables/);
  assert.throws(() => surface.loadSuccess({ environments: [], active: null, variables: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ environments: 'no', active: null, variables: [] }), /environments \(array\) and variables \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ environments: [{ id: 'e', name: 'E', kind: 'dev', token: 'x' }], active: 'e', variables: [] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: [], active: null, variables: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createEnvironmentsSurface();
  // environments: exact keys, closed kinds, unique ids
  assert.throws(() => surface.loadSuccess({ environments: ['x'], active: null, variables: [] }), /must be an object/);
  assert.throws(
    () => surface.loadSuccess({ environments: [{ id: 'e', name: 'E', kind: 'dev', extra: 1 }], active: 'e', variables: [] }),
    /must have exactly id,name,kind/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: [{ id: 'e', name: 'E', kind: 'qa' }], active: 'e', variables: [] }),
    /field kind must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: [{ id: 'e', name: 'E', kind: 'dev' }, { id: 'e', name: 'E2', kind: 'dev' }], active: 'e', variables: [] }),
    /repeats the id/,
  );
  // active consistency: known id when non-empty, null when empty, both directions
  assert.throws(
    () => surface.loadSuccess({ environments: ENVIRONMENTS, active: 'e-ghost', variables: [] }),
    /unknown environment "e-ghost"/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: ENVIRONMENTS, active: null, variables: [] }),
    /must name one of the handed-over environments/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: [], active: 'e-dev', variables: [] }),
    /must be null when no environments/,
  );
  // variables: exact keys, unique names, primitive values, resolvable scope
  assert.throws(
    () => surface.loadSuccess({ environments: ENVIRONMENTS, active: 'e-dev', variables: [{ name: 'A', value: 1, scope: 'all', extra: 1 }] }),
    /must have exactly name,value,scope/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: ENVIRONMENTS, active: 'e-dev', variables: [{ name: 'A', value: 1, scope: 'all' }, { name: 'A', value: 2, scope: 'all' }] }),
    /repeats the name/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: ENVIRONMENTS, active: 'e-dev', variables: [{ name: 'A', value: { nested: 1 }, scope: 'all' }] }),
    /must be a primitive/,
  );
  assert.throws(
    () => surface.loadSuccess({ environments: ENVIRONMENTS, active: 'e-dev', variables: [{ name: 'A', value: 1, scope: 'e-ghost' }] }),
    /scope must be "all" or a handed-over environment id/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch, no evaluator, no save', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'environments.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('eval('), false, 'there is no evaluator in this surface');
  assert.equal(code.includes('new Function'), false, 'there is no function constructor in this surface');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  const envAssigns = code.match(/environments = Object\.freeze\(payload\.environments/g) ?? [];
  assert.equal(envAssigns.length, 1, 'the handed-over environments are installed in loadSuccess exactly once');
  const varAssigns = code.match(/variables = Object\.freeze\(held\)/g) ?? [];
  assert.equal(varAssigns.length, 1, 'the handed-over variables are installed in loadSuccess exactly once');
  const activeAssigns = code.match(/activeId = payload\.active/g) ?? [];
  assert.equal(activeAssigns.length, 1, 'the active id comes from the hand-over exactly once - never derived locally');
});

test('A an expression-shaped value passes through verbatim - never evaluated', () => {
  const surface = loadedSurface();
  const expression = '={{ $env.API_URL }}';
  assert.equal(surface.setVariable('API_URL', expression), 'accepted');
  const row = surface.displayModel().shown.find((variable) => variable.name === 'API_URL');
  assert.equal(row.value, expression, 'the string is exactly what the hand-over carried');
  assert.equal(surface.setVariable('API_URL', expression), 'accepted', 're-setting is idempotent');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no evaluator ran: the surface is a pure view-model');
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.settings.environments');
  assert.ok(entry, 'ui.settings.environments is registered');
  assert.deepEqual(entry.surfaceIds, ['environments']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S18');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/55-environments.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the environments capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'environments');
  assert.ok(capability, 'environments capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/environments.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'environments');
  assert.deepEqual(capability.surfaces, ['environments']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n environments settings'), 'fallback keeps the reference settings');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/55-environments.test.mjs']);
  assert.equal(capability.phase, 'P2-S18');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createEnvironmentsSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createEnvironmentsSurface();
  empty.loadSuccess({ environments: [], active: null, variables: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createEnvironmentsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestSwitch: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(ENV_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(ENV_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(ENV_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(ENV_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), ENV_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createEnvironmentsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), ENV_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['env:e-dev', 'env:e-prev', 'env:e-stg', 'var:API_URL', 'var:RETRIES', 'var:EMPTY'],
    'environments first (handed-over order), then the scoped variables (all + e-dev; FEATURE_X is e-stg); submit appears only while dirty',
  );
  assert.equal(surface.setVariable('RETRIES', 5), 'accepted');
  model = surface.displayModel();
  assert.equal(model.focusOrder.at(-1), 'submit', 'saving is reachable after the records');
  assert.equal(model.focusOrder[0], 'env:e-dev', 'an edit never reorders the environments');
  for (const key of ['variable', 'scope', 'submit', 'switch', 'refresh']) {
    assert.equal(typeof ENV_LABELS[key], 'string');
    assert.ok(ENV_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, ENV_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'RETRIES', 'the change announces the variable name');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(envActionsFor('loading'), []);
  assert.deepEqual(envActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(envActionsFor('empty'), ['refresh']);
  assert.deepEqual(envActionsFor('ready'), ['refresh', 'set-variable', 'set-scope', 'request-submit', 'request-switch']);

  const loading = createEnvironmentsSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createEnvironmentsSurface();
  empty.loadSuccess({ environments: [], active: null, variables: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an environmentless workflow offers only refresh');
  const failed = createEnvironmentsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded variable list: default cap, hard clamp and truncation reported', () => {
  const environments = [{ id: 'e-dev', name: 'Development', kind: 'dev' }];
  const variables = Array.from({ length: 60 }, (_, i) => ({ name: `V${i}`, value: i, scope: ENV_GLOBAL_SCOPE }));
  const surface = loadedSurface(environments, 'e-dev', variables);
  assert.equal(surface.maxVisible, ENV_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, ENV_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createEnvironmentsSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, ENV_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createEnvironmentsSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createEnvironmentsSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const environments = [{ id: 'e-dev', name: 'Development', kind: 'dev' }];
  const variables = Array.from({ length: 200 }, (_, i) => ({ name: `VAR_${i}`, value: `value ${i}`, scope: ENV_GLOBAL_SCOPE }));
  const surface = createEnvironmentsSurface({ maxVisible: ENV_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ environments, active: 'e-dev', variables });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 variables x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createEnvironmentsSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ environments: ENVIRONMENTS, active: 'e-dev', variables: VARIABLES });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(ENVIRONMENTS, 'e-dev', VARIABLES, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.setVariable('RETRIES', 9);
  assert.equal(surface.degradedEvents, 2, 'the set counted');
  surface.setScope('RETRIES', 'e-stg');
  assert.equal(surface.degradedEvents, 3, 'the scope set counted');
  surface.requestSubmit();
  assert.equal(surface.degradedEvents, 4, 'the submit counted');
  surface.requestSwitch('e-prev');
  assert.equal(surface.degradedEvents, 5, 'the switch counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createEnvironmentsSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never move the active id', () => {
  const surface = loadedSurface();
  const snapshot = () => JSON.stringify(surface.displayModel().environments);
  const before = snapshot();
  // set-variable: primitives only, unknown refused, idempotent accepted
  assert.equal(surface.setVariable('GHOST', 1), 'unknown-variable');
  assert.equal(surface.setVariable('RETRIES', 'seven'), 'accepted', 'variables carry no type constraint beyond primitives');
  assert.equal(surface.setVariable('RETRIES', 'seven'), 'accepted', 're-setting is idempotent');
  assert.throws(() => surface.setVariable('RETRIES', { nested: 1 }), /must be a primitive/);
  assert.throws(() => surface.setVariable(' ', 1), /non-empty variable name/);
  // set-scope: closed vocabulary, unknown scope refused as a RESULT
  assert.equal(surface.setScope('GHOST', 'all'), 'unknown-variable');
  assert.equal(surface.setScope('RETRIES', 'e-ghost'), 'invalid-scope');
  assert.equal(surface.setScope('RETRIES', 'e-stg'), 'accepted');
  assert.equal(surface.setScope('RETRIES', 'e-stg'), 'accepted', 're-scoping is idempotent');
  // request-submit: dirty identity only
  assert.equal(surface.requestSubmit(), 'accepted');
  surface.setLoading();
  assert.equal(surface.setVariable('RETRIES', 1), 'not-ready');
  assert.equal(surface.setScope('RETRIES', 'all'), 'not-ready');
  assert.equal(surface.requestSubmit(), 'not-ready');
  assert.equal(surface.requestSwitch('e-prev'), 'not-ready');
  surface.loadSuccess({ environments: ENVIRONMENTS, active: 'e-dev', variables: VARIABLES });
  assert.equal(surface.displayModel().dirty, undefined, 'no dirty field escapes the display model');
  assert.equal(surface.requestSubmit(), 'no-changes', 'a fresh hand-over clears the dirty list');
  // request-switch: the handed-over active id NEVER moves here
  assert.equal(surface.requestSwitch('e-ghost'), 'unknown-environment');
  assert.equal(surface.requestSwitch('e-prev'), 'accepted');
  assert.equal(snapshot(), before, 'the handed-over environments (and the active flag) are byte-identical after every declared request');
  assert.equal(surface.activeId, 'e-dev', 'the active id changes only via a fresh hand-over');
  assert.throws(() => surface.requestSwitch(' '), /non-empty environment id/);
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ environments: [], active: null, variables: [] });
  assert.equal(surface.displayModel().reason, 'none', 'no environments is empty with reason none');
  assert.ok(ENV_SET_RESULTS.includes('unknown-variable'));
  assert.ok(ENV_SCOPE_RESULTS.includes('invalid-scope'));
  assert.ok(ENV_SUBMIT_RESULTS.includes('no-changes'));
  assert.ok(ENV_SWITCH_RESULTS.includes('unknown-environment'));
  for (const action of ENV_ACTIONS) assert.ok(ENV_ACTIONS.includes(action));
});
