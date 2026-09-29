/**
 * P2-S20 - Execution management surface pilot (issue #240, Layer 4).
 *
 * The strangler slice for the retry / stop / bulk actions around executions
 * (beyond the P2-S06 history list) split out of P2-S03. The execution
 * records are handed over - the surface never fetches, never mutates a
 * record and never calls the execution capability itself: retry / stop /
 * bulk are declared interactions with explicit results, and the selection is
 * view state cleared by every fresh hand-over.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {executions}, no fetch,
 *         no workflow save, secret envelope refused, closed REGION_STATES +
 *         status/action/result vocabularies (A)
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
  createExecutionMgmtSurface,
  executionMgmtSurfaceContract,
  execMgmtActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  EXEC_MGMT_STATES,
  EXECUTION_STATUSES,
  EXEC_MGMT_EMPTY_REASONS,
  EXEC_MGMT_ACTIONS,
  EXEC_MGMT_SELECT_RESULTS,
  EXEC_MGMT_RETRY_RESULTS,
  EXEC_MGMT_STOP_RESULTS,
  EXEC_MGMT_BULK_RETRY_RESULTS,
  EXEC_MGMT_BULK_STOP_RESULTS,
  EXEC_MGMT_LABELS,
  EXEC_MGMT_A11Y,
  EXEC_MGMT_MAX_VISIBLE_DEFAULT,
  EXEC_MGMT_MAX_VISIBLE_HARD_MAX,
  EXEC_MGMT_SURFACE_ID,
} from '../src/execution-mgmt.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const EXECUTIONS = [
  { id: 'x-ok', workflowName: 'Nightly sync', status: 'success' },
  { id: 'x-err', workflowName: 'Invoice export', status: 'error' },
  { id: 'x-run', workflowName: 'CRM mirror', status: 'running' },
  { id: 'x-wait', workflowName: 'Approval hop', status: 'waiting' },
];

function loadedSurface(executions = EXECUTIONS, options = {}) {
  const surface = createExecutionMgmtSurface(options);
  surface.loadSuccess({ executions });
  return surface;
}

const rowsSnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, workflowName, status }) => ({ id, workflowName, status })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = executionMgmtSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, EXEC_MGMT_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.executionStatuses, EXECUTION_STATUSES);
  assert.deepEqual(contract.vocabularies.actions, EXEC_MGMT_ACTIONS);
  assert.deepEqual(contract.vocabularies.selectResults, EXEC_MGMT_SELECT_RESULTS);
  assert.deepEqual(contract.vocabularies.retryResults, EXEC_MGMT_RETRY_RESULTS);
  assert.deepEqual(contract.vocabularies.stopResults, EXEC_MGMT_STOP_RESULTS);
  assert.deepEqual(contract.vocabularies.bulkRetryResults, EXEC_MGMT_BULK_RETRY_RESULTS);
  assert.deepEqual(contract.vocabularies.bulkStopResults, EXEC_MGMT_BULK_STOP_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, EXEC_MGMT_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, EXEC_MGMT_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, EXEC_MGMT_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(EXEC_MGMT_STATES, REGION_STATES);
  assert.deepEqual(EXEC_MGMT_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(EXECUTION_STATUSES, ['success', 'error', 'running', 'waiting']);
  for (const vocab of [EXECUTION_STATUSES, EXEC_MGMT_ACTIONS, EXEC_MGMT_SELECT_RESULTS, EXEC_MGMT_RETRY_RESULTS, EXEC_MGMT_STOP_RESULTS, EXEC_MGMT_BULK_RETRY_RESULTS, EXEC_MGMT_BULK_STOP_RESULTS, EXEC_MGMT_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createExecutionMgmtSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly executions/);
  assert.throws(() => surface.loadSuccess({ executions: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ executions: 'no' }), /executions \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ executions: [{ id: 'x', workflowName: 'W', status: 'success', token: 'x' }] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ executions: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createExecutionMgmtSurface();
  assert.throws(() => surface.loadSuccess({ executions: ['x'] }), /must be an object/);
  assert.throws(
    () => surface.loadSuccess({ executions: [{ id: 'x', workflowName: 'W', status: 'success', extra: 1 }] }),
    /must have exactly id,workflowName,status/,
  );
  assert.throws(
    () => surface.loadSuccess({ executions: [{ id: 'x', workflowName: 'W', status: 'canceled' }] }),
    /field status must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess({ executions: [{ id: 'x', workflowName: 'W', status: 'success' }, { id: 'x', workflowName: 'W2', status: 'error' }] }),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess({ executions: [{ id: '', workflowName: 'W', status: 'success' }] }),
    /field id must be a non-empty string/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch, no evaluator, no capability call', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'execution-mgmt.mjs'));
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
  const execAssigns = code.match(/executions = Object\.freeze\(payload\.executions/g) ?? [];
  assert.equal(execAssigns.length, 1, 'the handed-over executions are installed in loadSuccess exactly once');
  const statusWrites = code.match(/\.status\s*=\s*/g) ?? [];
  assert.equal(statusWrites.length, 0, 'no record status is ever written locally - only a fresh hand-over changes records');
});

test('A the declared actions never mutate a record - the execution capability owns every outcome', () => {
  const surface = loadedSurface();
  const before = rowsSnapshot(surface);
  assert.equal(surface.select('x-err'), 'accepted');
  assert.equal(surface.select('x-run'), 'accepted');
  assert.equal(surface.requestRetry('x-err'), 'accepted');
  assert.equal(surface.requestStop('x-run'), 'accepted');
  assert.equal(surface.requestBulkRetry(), 'accepted');
  assert.equal(surface.requestBulkStop(), 'accepted');
  assert.equal(rowsSnapshot(surface), before, 'id/workflowName/status are byte-identical after every declared action');
  assert.deepEqual(surface.selection, ['x-err', 'x-run'], 'only the view selection moved');
  assert.ok(EXEC_MGMT_RETRY_RESULTS.includes('accepted'));
  assert.ok(EXEC_MGMT_STOP_RESULTS.includes('invalid-state'));
  assert.ok(EXEC_MGMT_BULK_RETRY_RESULTS.includes('no-retryable'));
  assert.ok(EXEC_MGMT_BULK_STOP_RESULTS.includes('no-stoppable'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.executions.manage');
  assert.ok(entry, 'ui.executions.manage is registered');
  assert.deepEqual(entry.surfaceIds, ['execution-mgmt']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S20');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/57-execution-mgmt.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the execution-mgmt capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'execution-mgmt');
  assert.ok(capability, 'execution-mgmt capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/execution-mgmt.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'execution-mgmt');
  assert.deepEqual(capability.surfaces, ['execution-mgmt']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/57-execution-mgmt.test.mjs']);
  assert.equal(capability.phase, 'P2-S20');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createExecutionMgmtSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createExecutionMgmtSurface();
  empty.loadSuccess({ executions: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createExecutionMgmtSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestStop: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(EXEC_MGMT_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(EXEC_MGMT_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(EXEC_MGMT_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(EXEC_MGMT_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), EXEC_MGMT_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createExecutionMgmtSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), EXEC_MGMT_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['exec:x-ok', 'exec:x-err', 'exec:x-run', 'exec:x-wait'],
    'executions in hand-over order; bulk controls appear only with a selection',
  );
  assert.equal(surface.select('x-err'), 'accepted');
  model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['exec:x-ok', 'exec:x-err', 'exec:x-run', 'exec:x-wait', 'bulk-retry', 'bulk-stop'],
    'the bulk controls become reachable once something is selected, rows never reorder',
  );
  for (const key of ['select', 'retry', 'stop', 'bulkRetry', 'bulkStop', 'refresh']) {
    assert.equal(typeof EXEC_MGMT_LABELS[key], 'string');
    assert.ok(EXEC_MGMT_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, EXEC_MGMT_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'x-err', 'the selection announces the execution id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(execMgmtActionsFor('loading'), []);
  assert.deepEqual(execMgmtActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(execMgmtActionsFor('empty'), ['refresh']);
  assert.deepEqual(execMgmtActionsFor('ready'), ['refresh', 'select', 'request-retry', 'request-stop', 'request-bulk-retry', 'request-bulk-stop']);

  const loading = createExecutionMgmtSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createExecutionMgmtSurface();
  empty.loadSuccess({ executions: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an executionless workflow offers only refresh');
  const failed = createExecutionMgmtSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded execution list: default cap, hard clamp and truncation reported', () => {
  const executions = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, workflowName: `Flow ${i}`, status: 'success' }));
  const surface = loadedSurface(executions);
  assert.equal(surface.maxVisible, EXEC_MGMT_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, EXEC_MGMT_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createExecutionMgmtSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, EXEC_MGMT_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createExecutionMgmtSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createExecutionMgmtSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const executions = Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, workflowName: `Flow ${i}`, status: i % 2 ? 'error' : 'success' }));
  const surface = createExecutionMgmtSurface({ maxVisible: EXEC_MGMT_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ executions });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 executions x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createExecutionMgmtSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ executions: EXECUTIONS });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(EXECUTIONS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.select('x-run');
  assert.equal(surface.degradedEvents, 2, 'the selection counted');
  surface.requestStop('x-run');
  assert.equal(surface.degradedEvents, 3, 'the stop counted');
  surface.requestBulkStop();
  assert.equal(surface.degradedEvents, 4, 'the bulk stop counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createExecutionMgmtSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = rowsSnapshot(surface);
  // select: view state only, toggle, unknown refused
  assert.equal(surface.select('x-ghost'), 'unknown-execution');
  assert.equal(surface.select('x-ok'), 'accepted');
  assert.equal(surface.select('x-ok'), 'accepted', 're-selecting toggles off');
  assert.deepEqual(surface.selection, [], 'the toggle cleared it again');
  assert.throws(() => surface.select(' '), /non-empty execution id/);
  // retry: closed vocabulary, only error is retryable
  assert.equal(surface.requestRetry('x-ghost'), 'unknown-execution');
  assert.equal(surface.requestRetry('x-ok'), 'invalid-state', 'a successful run is not retryable');
  assert.equal(surface.requestRetry('x-err'), 'accepted');
  assert.throws(() => surface.requestRetry(' '), /non-empty execution id/);
  // stop: only running/waiting is stoppable
  assert.equal(surface.requestStop('x-ghost'), 'unknown-execution');
  assert.equal(surface.requestStop('x-ok'), 'invalid-state', 'a finished run cannot be stopped');
  assert.equal(surface.requestStop('x-run'), 'accepted');
  assert.equal(surface.requestStop('x-wait'), 'accepted');
  // bulk: selection-gated closed results
  assert.equal(surface.requestBulkRetry(), 'no-selection');
  assert.equal(surface.requestBulkStop(), 'no-selection');
  surface.select('x-ok');
  assert.equal(surface.requestBulkRetry(), 'no-retryable', 'nothing retryable in the selection');
  surface.select('x-err');
  assert.equal(surface.requestBulkRetry(), 'accepted', 'a failed execution is retryable');
  assert.equal(surface.requestBulkStop(), 'no-stoppable', 'success+error cannot be stopped');
  surface.select('x-run');
  assert.equal(surface.requestBulkStop(), 'accepted', 'a running execution can be stopped');
  // not-ready everywhere beyond refresh
  surface.setLoading();
  assert.equal(surface.select('x-ok'), 'not-ready');
  assert.equal(surface.requestRetry('x-err'), 'not-ready');
  assert.equal(surface.requestStop('x-run'), 'not-ready');
  assert.equal(surface.requestBulkRetry(), 'not-ready');
  assert.equal(surface.requestBulkStop(), 'not-ready');
  // fresh hand-over clears the selection; records stay byte-identical
  surface.loadSuccess({ executions: EXECUTIONS });
  assert.deepEqual(surface.selection, [], 'a fresh hand-over clears the selection');
  assert.equal(surface.requestBulkRetry(), 'no-selection');
  assert.equal(rowsSnapshot(surface), before, 'id/workflowName/status are byte-identical after every declared request');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ executions: [] });
  assert.equal(surface.displayModel().reason, 'none', 'no executions is empty with reason none');
  assert.equal(surface.select('x-ok'), 'not-ready');
  assert.ok(EXEC_MGMT_SELECT_RESULTS.includes('unknown-execution'));
  assert.ok(EXEC_MGMT_RETRY_RESULTS.includes('invalid-state'));
  assert.ok(EXEC_MGMT_BULK_RETRY_RESULTS.includes('no-selection'));
  assert.ok(EXEC_MGMT_BULK_STOP_RESULTS.includes('no-stoppable'));
  for (const action of EXEC_MGMT_ACTIONS) assert.ok(EXEC_MGMT_ACTIONS.includes(action));
});
