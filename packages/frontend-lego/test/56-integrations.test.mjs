/**
 * P2-S19 - Integrations surface pilot (issue #240, Layer 4).
 *
 * The strangler slice for the external integration management panel
 * (community / private / custom sources view) split out of P2-S03. The
 * integration records and the active id are handed over - the surface never
 * fetches, never derives the active integration locally and NEVER installs:
 * request-install is declared and always lands behind the P6 admission path.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {integrations, active},
 *         no fetch, no workflow save, secret envelope refused, closed
 *         REGION_STATES + source/action/result vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared request vocabularies, admission path never bypassed (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createIntegrationsSurface,
  integrationsSurfaceContract,
  integrationsActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  INTEGRATION_STATES,
  INTEGRATION_SOURCES,
  INTEGRATION_EMPTY_REASONS,
  INTEGRATION_ACTIONS,
  INTEGRATION_ACTIVATE_RESULTS,
  INTEGRATION_INSTALL_RESULTS,
  INTEGRATION_LABELS,
  INTEGRATION_A11Y,
  INTEGRATION_MAX_VISIBLE_DEFAULT,
  INTEGRATION_MAX_VISIBLE_HARD_MAX,
  INTEGRATION_SURFACE_ID,
} from '../src/integrations.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const INTEGRATIONS = [
  { id: 'i-comm', name: 'Community HTTP Plus', source: 'community', installed: false },
  { id: 'i-priv', name: 'Acme Connector', source: 'private', installed: true },
  { id: 'i-custom', name: 'In-house Bridge', source: 'custom', installed: false },
];

function loadedSurface(integrations = INTEGRATIONS, active = 'i-comm', options = {}) {
  const surface = createIntegrationsSurface(options);
  surface.loadSuccess({ integrations, active });
  return surface;
}

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = integrationsSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, INTEGRATION_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.sources, INTEGRATION_SOURCES);
  assert.deepEqual(contract.vocabularies.actions, INTEGRATION_ACTIONS);
  assert.deepEqual(contract.vocabularies.activateResults, INTEGRATION_ACTIVATE_RESULTS);
  assert.deepEqual(contract.vocabularies.installResults, INTEGRATION_INSTALL_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, INTEGRATION_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, INTEGRATION_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, INTEGRATION_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(INTEGRATION_STATES, REGION_STATES);
  assert.deepEqual(INTEGRATION_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(INTEGRATION_SOURCES, ['community', 'private', 'custom']);
  for (const vocab of [INTEGRATION_SOURCES, INTEGRATION_ACTIONS, INTEGRATION_ACTIVATE_RESULTS, INTEGRATION_INSTALL_RESULTS, INTEGRATION_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createIntegrationsSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({ integrations: [] }), /must have exactly integrations,active/);
  assert.throws(() => surface.loadSuccess({ integrations: [], active: null, extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ integrations: 'no', active: null }), /integrations \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ integrations: [{ id: 'i', name: 'I', source: 'community', installed: false, token: 'x' }], active: 'i' }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ integrations: [], active: null, sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createIntegrationsSurface();
  // integrations: exact keys, closed sources, unique ids, boolean installed
  assert.throws(() => surface.loadSuccess({ integrations: ['x'], active: null }), /must be an object/);
  assert.throws(
    () => surface.loadSuccess({ integrations: [{ id: 'i', name: 'I', source: 'community', extra: 1 }], active: 'i' }),
    /must have exactly id,name,source,installed/,
  );
  assert.throws(
    () => surface.loadSuccess({ integrations: [{ id: 'i', name: 'I', source: 'registry', installed: false }], active: 'i' }),
    /field source must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess({ integrations: [{ id: 'i', name: 'I', source: 'community', installed: 'yes' }], active: 'i' }),
    /field installed must be a boolean/,
  );
  assert.throws(
    () => surface.loadSuccess({ integrations: [{ id: 'i', name: 'I', source: 'community', installed: false }, { id: 'i', name: 'I2', source: 'private', installed: false }], active: 'i' }),
    /repeats the id/,
  );
  // active consistency: known id when non-empty, null when empty, both directions
  assert.throws(
    () => surface.loadSuccess({ integrations: INTEGRATIONS, active: 'i-ghost' }),
    /unknown integration "i-ghost"/,
  );
  assert.throws(
    () => surface.loadSuccess({ integrations: INTEGRATIONS, active: null }),
    /must name one of the handed-over integrations/,
  );
  assert.throws(
    () => surface.loadSuccess({ integrations: [], active: 'i-comm' }),
    /must be null when no integrations/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch, no evaluator, no installer', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'integrations.mjs'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('eval('), false, 'there is no evaluator in this surface');
  assert.equal(code.includes('new Function'), false, 'there is no function constructor in this surface');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  assert.equal(code.includes('child_process'), false, 'the surface never shells out');
  assert.equal(code.includes('import('), false, 'the surface never dynamically imports an installer');
  const listAssigns = code.match(/integrations = Object\.freeze\(payload\.integrations/g) ?? [];
  assert.equal(listAssigns.length, 1, 'the handed-over integrations are installed in loadSuccess exactly once');
  const activeAssigns = code.match(/activeId = payload\.active/g) ?? [];
  assert.equal(activeAssigns.length, 1, 'the active id comes from the hand-over exactly once - never derived locally');
  const installWrites = code.match(/installed\s*=\s*(true|false)/g) ?? [];
  assert.equal(installWrites.length, 0, 'the installed flags are never written locally - only a fresh hand-over changes them');
});

test('A installs stay behind the P6 admission path: declared, never executed, never claimed', () => {
  const surface = loadedSurface();
  const before = JSON.stringify(surface.displayModel().shown);
  const result = surface.requestInstall();
  assert.equal(result, 'admission-required', 'the request is queued for the P6 admission path - there is no accepted result');
  assert.ok(INTEGRATION_INSTALL_RESULTS.includes(result));
  assert.equal(INTEGRATION_INSTALL_RESULTS.includes('accepted'), false, 'the closed install vocabulary has NO accepted result');
  assert.equal(JSON.stringify(surface.displayModel().shown), before, 'installed flags are byte-identical after the request');
  assert.equal(surface.activeId, 'i-comm', 'the active id never moves here either');
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.integrations.manage');
  assert.ok(entry, 'ui.integrations.manage is registered');
  assert.deepEqual(entry.surfaceIds, ['integrations']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S19');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/56-integrations.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the integrations capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'integrations');
  assert.ok(capability, 'integrations capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/integrations.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'integrations');
  assert.deepEqual(capability.surfaces, ['integrations']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/56-integrations.test.mjs']);
  assert.equal(capability.phase, 'P2-S19');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createIntegrationsSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createIntegrationsSurface();
  empty.loadSuccess({ integrations: [], active: null });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createIntegrationsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestInstall: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(INTEGRATION_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(INTEGRATION_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(INTEGRATION_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(INTEGRATION_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), INTEGRATION_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createIntegrationsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), INTEGRATION_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['integration:i-comm', 'integration:i-priv', 'integration:i-custom', 'install'],
    'integrations in handed-over order; install is reachable because the active integration is not installed yet',
  );
  assert.equal(surface.requestActivate('i-priv'), 'accepted');
  model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['integration:i-comm', 'integration:i-priv', 'integration:i-custom', 'install'],
    'the activation never reorders the list and never moves the handed-over active id - the install control stays until a fresh hand-over',
  );
  for (const key of ['activate', 'install', 'refresh']) {
    assert.equal(typeof INTEGRATION_LABELS[key], 'string');
    assert.ok(INTEGRATION_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, INTEGRATION_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'i-priv', 'the activation announces the integration id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(integrationsActionsFor('loading'), []);
  assert.deepEqual(integrationsActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(integrationsActionsFor('empty'), ['refresh']);
  assert.deepEqual(integrationsActionsFor('ready'), ['refresh', 'request-activate', 'request-install']);

  const loading = createIntegrationsSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createIntegrationsSurface();
  empty.loadSuccess({ integrations: [], active: null });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an integrationless workflow offers only refresh');
  const failed = createIntegrationsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded integration list: default cap, hard clamp and truncation reported', () => {
  const integrations = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, name: `Integration ${i}`, source: 'community', installed: false }));
  const surface = loadedSurface(integrations, 'i0');
  assert.equal(surface.maxVisible, INTEGRATION_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, INTEGRATION_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createIntegrationsSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, INTEGRATION_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createIntegrationsSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createIntegrationsSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const integrations = Array.from({ length: 200 }, (_, i) => ({ id: `i${i}`, name: `Integration ${i}`, source: 'community', installed: false }));
  const surface = createIntegrationsSurface({ maxVisible: INTEGRATION_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ integrations, active: 'i0' });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 integrations x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createIntegrationsSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ integrations: INTEGRATIONS, active: 'i-comm' });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(INTEGRATIONS, 'i-comm', { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestActivate('i-priv');
  assert.equal(surface.degradedEvents, 2, 'the activation counted');
  surface.requestInstall();
  assert.equal(surface.degradedEvents, 3, 'the install request counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createIntegrationsSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const snapshot = () => JSON.stringify(surface.displayModel().shown) + surface.activeId;
  const before = snapshot();
  // request-activate: unknown refused as a RESULT, idempotent accepted, never moves active
  assert.equal(surface.requestActivate('i-ghost'), 'unknown-integration');
  assert.equal(surface.requestActivate('i-custom'), 'accepted');
  assert.equal(surface.requestActivate('i-custom'), 'accepted', 're-activating is idempotent');
  assert.throws(() => surface.requestActivate(' '), /non-empty integration id/);
  // request-install: closed results, admission never bypassed, installed never flips
  assert.equal(surface.requestInstall(), 'admission-required', 'i-comm is not installed: the admission path answers');
  const installedActive = loadedSurface(INTEGRATIONS, 'i-priv');
  assert.equal(installedActive.requestInstall(), 'already-installed', 'an installed active integration is an explicit result');
  // In the ready region the hand-over consistency pins the active id to a
  // known integration, so unknown-integration has no reachable install path
  // here - it stays in the closed vocabulary for the app layer's stricter
  // re-validation (declared, never dropped).
  // not-ready everywhere beyond refresh
  surface.setLoading();
  assert.equal(surface.requestActivate('i-custom'), 'not-ready');
  assert.equal(surface.requestInstall(), 'not-ready');
  surface.loadSuccess({ integrations: INTEGRATIONS, active: 'i-comm' });
  assert.equal(snapshot(), before, 'the handed-over integrations (and the active id) are byte-identical after every declared request');
  assert.equal(surface.activeId, 'i-comm', 'the active id changes only via a fresh hand-over');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ integrations: [], active: null });
  assert.equal(surface.displayModel().reason, 'none', 'no integrations is empty with reason none');
  assert.equal(surface.requestActivate('i-comm'), 'not-ready');
  assert.ok(INTEGRATION_ACTIVATE_RESULTS.includes('unknown-integration'));
  assert.ok(INTEGRATION_INSTALL_RESULTS.includes('admission-required'));
  assert.ok(INTEGRATION_INSTALL_RESULTS.includes('already-installed'));
  assert.ok(INTEGRATION_INSTALL_RESULTS.includes('not-ready'));
  for (const action of INTEGRATION_ACTIONS) assert.ok(INTEGRATION_ACTIONS.includes(action));
});
