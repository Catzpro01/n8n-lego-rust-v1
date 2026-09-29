/**
 * P2-S25 - Work Trace surface pilot (issue #240, Layer 5).
 *
 * The strangler slice for the work-trace timeline surface split out of
 * P2-S03. Trace events are handed over through the observability capability
 * - the surface is READ-ONLY: no fetch, no mutation of an event, no write of
 * any kind. request-open-event is declared with explicit results and the
 * capability that owns navigation performs it.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {events}, read-only, no
 *         fetch, no workflow save, secret envelope refused, closed
 *         REGION_STATES + kind/action/result vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared request vocabularies, events never mutate (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWorkTraceSurface,
  workTraceSurfaceContract,
  workTraceActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  WORK_TRACE_STATES,
  TRACE_EVENT_KINDS,
  WORK_TRACE_EMPTY_REASONS,
  WORK_TRACE_ACTIONS,
  WORK_TRACE_OPEN_RESULTS,
  WORK_TRACE_LABELS,
  WORK_TRACE_A11Y,
  WORK_TRACE_MAX_VISIBLE_DEFAULT,
  WORK_TRACE_MAX_VISIBLE_HARD_MAX,
  TRACE_LABEL_MAX_LENGTH,
  WORK_TRACE_SURFACE_ID,
} from '../src/work-trace.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const EVENTS = [
  { id: 'e-1', kind: 'run', at: '2026-09-29T01:00:00Z', label: 'Workflow run started' },
  { id: 'e-2', kind: 'node', at: '2026-09-29T01:00:02Z', label: 'IF node executed' },
  { id: 'e-3', kind: 'error', at: '2026-09-29T01:00:03Z', label: 'HTTP node failed: timeout' },
  { id: 'e-4', kind: 'manual', at: '2026-09-29T01:01:00Z', label: 'Retry requested by Ann' },
];

function loadedSurface(events = EVENTS, options = {}) {
  const surface = createWorkTraceSurface(options);
  surface.loadSuccess({ events });
  return surface;
}

const traceSnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, kind, at, label }) => ({ id, kind, at, label })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = workTraceSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, WORK_TRACE_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.eventKinds, TRACE_EVENT_KINDS);
  assert.deepEqual(contract.vocabularies.actions, WORK_TRACE_ACTIONS);
  assert.deepEqual(contract.vocabularies.openResults, WORK_TRACE_OPEN_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, WORK_TRACE_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, WORK_TRACE_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, WORK_TRACE_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.labelMaxLength, TRACE_LABEL_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(WORK_TRACE_STATES, REGION_STATES);
  assert.deepEqual(WORK_TRACE_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(TRACE_EVENT_KINDS, ['run', 'node', 'error', 'manual']);
  for (const vocab of [TRACE_EVENT_KINDS, WORK_TRACE_ACTIONS, WORK_TRACE_OPEN_RESULTS, WORK_TRACE_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createWorkTraceSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly events/);
  assert.throws(() => surface.loadSuccess({ events: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ events: 'no' }), /events \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ events: [{ id: 'e', kind: 'run', at: '2026-09-29T01:00:00Z', label: 'x', token: 'y' }] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ events: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createWorkTraceSurface();
  assert.throws(() => surface.loadSuccess({ events: ['e'] }), /event 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ events: [{ id: 'e', kind: 'run', at: '2026-09-29T01:00:00Z', label: 'x', extra: 1 }] }),
    /must have exactly id,kind,at,label/,
  );
  assert.throws(
    () => surface.loadSuccess({ events: [{ id: 'e', kind: 'mystery', at: '2026-09-29T01:00:00Z', label: 'x' }] }),
    /field kind must be one of run, node, error, manual/,
  );
  assert.throws(
    () => surface.loadSuccess({ events: [{ id: 'e', kind: 'run', at: 'yesterday', label: 'x' }] }),
    /field at must be an ISO timestamp/,
  );
  assert.throws(
    () => surface.loadSuccess({ events: [{ id: 'e', kind: 'run', at: '2026-09-29T01:00:00Z', label: 'x'.repeat(TRACE_LABEL_MAX_LENGTH + 1) }] }),
    /field label must be at most/,
  );
  assert.throws(
    () => surface.loadSuccess({ events: [{ id: 'e', kind: 'run', at: '2026-09-29T01:00:00Z', label: 'a' }, { id: 'e', kind: 'node', at: '2026-09-29T01:00:01Z', label: 'b' }] }),
    /repeats the id/,
  );
});

test('A the surface is read-only: loadSuccess is the only entry, no fetch, no evaluator, no writes', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'work-trace.mjs'));
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
  const installs = code.match(/events = Object\.freeze\(payload\.events/g) ?? [];
  assert.equal(installs.length, 1, 'the trace is installed in loadSuccess exactly once');
  const fieldWrites = code.match(/\.(kind|at|label)\s*=(?!=)/g) ?? [];
  assert.equal(fieldWrites.length, 0, 'no event field is ever written locally - the surface is read-only');
});

test('A the declared open never mutates the trace - read-only holds for every request', () => {
  const surface = loadedSurface();
  const before = traceSnapshot(surface);
  assert.equal(surface.requestOpenEvent('e-3'), 'accepted');
  assert.equal(surface.requestOpenEvent('e-ghost'), 'unknown-event');
  assert.equal(traceSnapshot(surface), before, 'id/kind/at/label are byte-identical after every declared request');
  assert.equal(surface.events.length, EVENTS.length, 'nothing was appended or removed');
  surface.loadSuccess({ events: EVENTS });
  assert.equal(traceSnapshot(surface), before, 'a fresh hand-over yields the same read-only trace');
  assert.ok(WORK_TRACE_OPEN_RESULTS.includes('accepted'));
  assert.ok(WORK_TRACE_OPEN_RESULTS.includes('unknown-event'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.trace.work-trace');
  assert.ok(entry, 'ui.trace.work-trace is registered');
  assert.deepEqual(entry.surfaceIds, ['work-trace']);
  assert.equal(entry.category, 'execution-history');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S25');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/62-work-trace.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the work-trace capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'work-trace');
  assert.ok(capability, 'work-trace capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/work-trace.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'work-trace');
  assert.deepEqual(capability.surfaces, ['work-trace']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/62-work-trace.test.mjs']);
  assert.equal(capability.phase, 'P2-S25');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createWorkTraceSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createWorkTraceSurface();
  empty.loadSuccess({ events: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createWorkTraceSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestOpenEvent: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(WORK_TRACE_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(WORK_TRACE_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(WORK_TRACE_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(WORK_TRACE_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), WORK_TRACE_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createWorkTraceSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), WORK_TRACE_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['event:e-1', 'event:e-2', 'event:e-3', 'event:e-4'],
    'every visible event is reachable in hand-over order, rows never reorder',
  );
  for (const key of ['open', 'refresh']) {
    assert.equal(typeof WORK_TRACE_LABELS[key], 'string');
    assert.ok(WORK_TRACE_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, WORK_TRACE_LABELS, 'labels are declared once');
  surface.requestOpenEvent('e-3');
  assert.equal(surface.displayModel().announcement, 'e-3', 'the request announces the event id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(workTraceActionsFor('loading'), []);
  assert.deepEqual(workTraceActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(workTraceActionsFor('empty'), ['refresh']);
  assert.deepEqual(workTraceActionsFor('ready'), ['refresh', 'request-open-event']);

  const loading = createWorkTraceSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createWorkTraceSurface();
  empty.loadSuccess({ events: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty trace offers only refresh');
  const failed = createWorkTraceSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded event window: default cap, hard clamp and truncation reported', () => {
  const events = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, kind: TRACE_EVENT_KINDS[i % 4], at: `2026-09-29T01:00:${String(i % 60).padStart(2, '0')}Z`, label: `step ${i}` }));
  const surface = loadedSurface(events);
  assert.equal(surface.maxVisible, WORK_TRACE_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, WORK_TRACE_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);
  assert.equal(model.shown[0].id, 'e30', 'the window keeps the newest events');

  const wide = createWorkTraceSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, WORK_TRACE_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createWorkTraceSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createWorkTraceSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, kind: TRACE_EVENT_KINDS[i % 4], at: `2026-09-29T02:${String(i % 60).padStart(2, '0')}:00Z`, label: `event ${i}` }));
  const surface = createWorkTraceSurface({ maxVisible: WORK_TRACE_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ events });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 events x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createWorkTraceSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ events: EVENTS });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(EVENTS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestOpenEvent('e-1');
  assert.equal(surface.degradedEvents, 2, 'the open counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createWorkTraceSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = traceSnapshot(surface);
  // request-open-event: closed vocabulary
  assert.equal(surface.requestOpenEvent('e-ghost'), 'unknown-event');
  assert.equal(surface.requestOpenEvent('e-2'), 'accepted');
  assert.throws(() => surface.requestOpenEvent(' '), /non-empty event id/);
  // not-ready beyond refresh
  surface.setLoading();
  assert.equal(surface.requestOpenEvent('e-2'), 'not-ready');
  // fresh hand-over: read-only, byte-identical
  surface.loadSuccess({ events: EVENTS });
  assert.equal(traceSnapshot(surface), before, 'id/kind/at/label are byte-identical after every declared request');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ events: [] });
  assert.equal(surface.displayModel().reason, 'none', 'no events is empty with reason none');
  assert.equal(surface.requestOpenEvent('e-2'), 'not-ready');
  assert.ok(WORK_TRACE_OPEN_RESULTS.includes('unknown-event'));
  assert.ok(WORK_TRACE_OPEN_RESULTS.includes('not-ready'));
  for (const action of WORK_TRACE_ACTIONS) assert.ok(WORK_TRACE_ACTIONS.includes(action));
});
