/**
 * P2-S08 - Workflow editor host pilot (issue #240).
 *
 * The strangler slice for the editor chrome AROUND the canvas (name/tags/
 * active-state header + workflow-level actions panel). The canvas/editor
 * rewrite stays out of scope (ui.editor.canvas reference-only, issue #241).
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: read-only hand-over, no workflow-data
 *         mutation, closed REGION_STATES, refusals (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, assertive/busy exclusivity (D)
 *   CP-05 bounds + draft mutation + explicit requests and failure (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWorkflowEditorSurface,
  workflowEditorSurfaceContract,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  WORKFLOW_EDITOR_STATES,
  WORKFLOW_EDITOR_ACTIONS,
  WORKFLOW_EDITOR_ACTIVE_STATES,
  WORKFLOW_EDITOR_REQUEST_RESULTS,
  WORKFLOW_EDITOR_A11Y,
  WORKFLOW_EDITOR_MAX_VISIBLE_HARD_MAX,
  WORKFLOW_EDITOR_NAME_MAX,
  WORKFLOW_EDITOR_SURFACE_ID,
} from '../src/workflow-editor.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKFLOW = {
  id: 'wf-1',
  name: 'Morning digest',
  active: true,
  tags: [
    { id: 't-1', name: 'ops' },
    { id: 't-2', name: 'digest' },
  ],
  versionId: 'v-1',
};

function readySurface() {
  const surface = createWorkflowEditorSurface();
  surface.loadSuccess(WORKFLOW);
  return surface;
}

/* ------------------------------------------------------------- A (CP-01) */

test('A the workflow record enters only through loadSuccess, read-only', () => {
  const surface = createWorkflowEditorSurface();
  assert.equal(surface.contract.inputBoundary.source, 'hand-over');
  assert.equal(surface.contract.inputBoundary.entryPoint, 'loadSuccess');
  assert.equal(surface.contract.inputBoundary.mutatesWorkflowData, false);
  surface.loadSuccess(WORKFLOW);
  // The handed-over record is an immutable snapshot: the surface never mutates it.
  assert.equal(surface.workflowSnapshot.name, 'Morning digest');
  assert.equal(surface.workflowSnapshot.active, true);
  assert.ok(Object.isFrozen(surface.workflowSnapshot));
  assert.ok(Object.isFrozen(surface.workflowSnapshot.tags));
});

test('A a workflow outside the closed shape is refused, not dropped', () => {
  const surface = createWorkflowEditorSurface();
  assert.throws(() => surface.loadSuccess({ id: 'x', name: 'X' }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ ...WORKFLOW, extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ ...WORKFLOW, active: 'yes' }), /active must be a boolean/);
  assert.throws(() => surface.loadSuccess({ ...WORKFLOW, tags: [{ id: 't' }] }), /tag 0 must have exactly id,name/);
  assert.throws(() => surface.loadSuccess({ ...WORKFLOW, tags: [{ id: 't', name: 'n', x: 1 }] }), /tag 0 must have exactly id,name/);
  assert.throws(() => surface.loadSuccess('wf'), /must be an object/);
});

test('A the contract states are pinned to REGION_STATES exactly - no fifth state', () => {
  const contract = workflowEditorSurfaceContract();
  assert.deepEqual(Object.keys(contract.states), [...REGION_STATES]);
  assert.deepEqual([...WORKFLOW_EDITOR_STATES], [...REGION_STATES]);
  const surface = createWorkflowEditorSurface();
  surface.loadSuccess(null); // no workflow in context is EMPTY, not a fifth state
  assert.equal(surface.observe().regionState, 'empty');
  assert.equal(surface.displayModel().reason, 'none');
  assert.deepEqual(Object.keys(surface.contract.states), [...REGION_STATES]);
});

test('A the action, result and active-state vocabularies are closed', () => {
  const contract = workflowEditorSurfaceContract();
  assert.deepEqual([...contract.vocabularies.actions], [...WORKFLOW_EDITOR_ACTIONS]);
  assert.deepEqual([...contract.vocabularies.requestResults], [...WORKFLOW_EDITOR_REQUEST_RESULTS]);
  assert.deepEqual([...contract.vocabularies.activeStates], ['active', 'inactive']);
  assert.deepEqual([...WORKFLOW_EDITOR_ACTIVE_STATES], ['active', 'inactive']);
});

/* ------------------------------------------------------------- B (CP-02) */

test('B the surface migrates as a pilot with rollback pilot-not-primary', () => {
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === 'ui.editor.workflow');
  assert.ok(entry, 'ui.editor.workflow entry exists');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.match(entry.evidencePath, /45-workflow-editor\.test\.mjs/);
  assert.deepEqual(entry.surfaceIds, [WORKFLOW_EDITOR_SURFACE_ID]);
  assert.equal(entry.slice, 'P2-S08');
  // Refresh 2026-09-28 (P2-S14): canvas was reference-only while the canvas rewrite
  // stayed out of scope (issue #241); P2-S14 delivers it as its own pilot, so the
  // sibling entry is now pilot-available with rollback pilot-not-primary (below).
  const canvas = inv.entries.find((e) => e.inventoryId === 'ui.editor.canvas');
  assert.equal(canvas.migrationStatus, 'pilot-available');
  assert.equal(canvas.rollbackStrategy, 'pilot-not-primary');
  assert.equal(canvas.slice, 'P2-S14');
});

test('B the capability declares the pilot and degrades to native behavior', () => {
  const caps = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'capabilities.json'), 'utf8'));
  const list = caps.capabilities ?? caps;
  const cap = list.find((c) => c.id === WORKFLOW_EDITOR_SURFACE_ID);
  assert.ok(cap, 'workflow-editor capability declared');
  assert.equal(cap.entry, './src/workflow-editor.mjs');
  assert.equal(cap.degradation.fallback, 'native-behavior');
  assert.ok(cap.tests.some((t) => /45-workflow-editor\.test\.mjs/.test(t)));
  assert.deepEqual(cap.surfaces, [WORKFLOW_EDITOR_SURFACE_ID]);
});

/* ------------------------------------------------------------- C (CP-03) */

test('C loading is parity-equivalent to the reference', () => {
  const surface = createWorkflowEditorSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C no workflow in context (empty) is parity-equivalent', () => {
  const surface = createWorkflowEditorSurface();
  surface.loadSuccess(null);
  const { status } = compareObservations(referenceEmptyObservation({ reason: 'none' }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C a loaded header is parity-equivalent (active record)', () => {
  const surface = readySurface();
  const { status } = compareObservations(referenceReadyObservation({ active: true }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C an inactive record is parity-equivalent (set-active is the declared action)', () => {
  const surface = createWorkflowEditorSurface();
  surface.loadSuccess({ ...WORKFLOW, active: false });
  const { status } = compareObservations(referenceReadyObservation({ active: false }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createWorkflowEditorSurface();
  surface.loadFailure({ kind: 'timeout' });
  const { status } = compareObservations(referenceErrorObservation({ errorKind: 'timeout' }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C the harness is fail-closed: a drifted field is migration-required', () => {
  const surface = createWorkflowEditorSurface();
  surface.loadSuccess(null);
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

test('D the a11y intent is derived once from WORKFLOW_EDITOR_A11Y', () => {
  const surface = readySurface();
  assert.equal(surface.a11y(), WORKFLOW_EDITOR_A11Y.ready);
  assert.deepEqual(surface.observe().accessibility, WORKFLOW_EDITOR_A11Y.ready);
});

test('D only error is assertive and only loading is busy', () => {
  for (const state of REGION_STATES) {
    const attrs = WORKFLOW_EDITOR_A11Y[state];
    if (state === 'error') assert.equal(attrs.ariaLive, 'assertive');
    else assert.equal(attrs.ariaLive, 'polite');
    if (state === 'loading') assert.equal(attrs.ariaBusy, true);
    else assert.equal(attrs.ariaBusy, false);
  }
});

/* ------------------------------------------------------------- E (CP-05) */

test('E the tag chips list is bounded and truncation is observable', () => {
  const tags = Array.from({ length: 30 }, (unused, i) => ({ id: `t-${i}`, name: `tag${i}` }));
  const surface = createWorkflowEditorSurface({ maxVisible: 3 });
  surface.loadSuccess({ ...WORKFLOW, tags });
  const model = surface.displayModel();
  assert.equal(model.tags.length, 3);
  assert.equal(model.truncated, true);
  assert.equal(model.tagsTotal, 30);
  const capped = createWorkflowEditorSurface({ maxVisible: WORKFLOW_EDITOR_MAX_VISIBLE_HARD_MAX + 10 });
  assert.equal(capped.maxVisible, WORKFLOW_EDITOR_MAX_VISIBLE_HARD_MAX);
  assert.throws(() => createWorkflowEditorSurface({ maxVisible: 0 }), /positive integer/);
});

test('E the rename draft is a local mutation: visible, bounded, never applied', () => {
  const surface = readySurface();
  assert.equal(surface.setDraftName('Afternoon digest'), 'draft');
  let model = surface.displayModel();
  assert.equal(model.draftName, 'Afternoon digest');
  assert.equal(model.dirty, true);
  assert.ok(model.actions.includes('clear-draft'));
  // The handed-over record never changed.
  assert.equal(surface.workflowSnapshot.name, 'Morning digest');
  // The draft is bounded; a longer name is refused, not truncated.
  assert.throws(() => surface.setDraftName('x'.repeat(WORKFLOW_EDITOR_NAME_MAX + 1)), /at most/);
  assert.throws(() => surface.setDraftName('   '), /non-empty/);
  assert.throws(() => surface.setDraftName(42), /string/);
  assert.equal(surface.clearDraft(), 'cleared');
  model = surface.displayModel();
  assert.equal(model.draftName, null);
  assert.equal(model.dirty, false);
});

test('E requests are declared and explicit, and workflow data never changes', () => {
  const surface = readySurface();
  assert.equal(surface.requestRename(), 'no-draft');
  surface.setDraftName('Renamed');
  assert.equal(surface.requestRename(), 'requested');
  // Even after the request, the record keeps its handed-over name (the surface never mutates).
  assert.equal(surface.workflowSnapshot.name, 'Morning digest');
  assert.equal(surface.requestActiveToggle(), 'requested');
  assert.equal(surface.workflowSnapshot.active, true);
  surface.setLoading();
  assert.equal(surface.requestRename(), 'not-ready');
  assert.equal(surface.requestActiveToggle(), 'not-ready');
  assert.equal(surface.setDraftName('x'), 'not-ready');
  assert.ok(WORKFLOW_EDITOR_REQUEST_RESULTS.includes('unchanged'));
});

test('E failure is explicit: the error region carries a retry affordance', () => {
  const surface = createWorkflowEditorSurface();
  assert.equal(surface.loadFailure({ kind: 'network' }), 'error');
  const model = surface.displayModel();
  assert.deepEqual([...model.actions], ['refresh']);
  assert.throws(() => surface.loadFailure(null), /error object/);
  // Degraded mode is observable, never silent.
  const degraded = createWorkflowEditorSurface({ renderAvailable: false });
  degraded.loadSuccess(WORKFLOW);
  assert.ok(degraded.degradedEvents > 0);
});

test('E a new hand-over clears a stale draft and history is deterministic', () => {
  const surface = readySurface();
  surface.setDraftName('Stale');
  surface.loadSuccess({ ...WORKFLOW, name: 'Second record' });
  assert.equal(surface.displayModel().draftName, null);
  assert.equal(surface.displayModel().name, 'Second record');
  const again = createWorkflowEditorSurface();
  again.loadSuccess(WORKFLOW);
  again.setDraftName('Hello');
  again.requestRename();
  assert.deepEqual(again.history.map((h) => h.name), ['loaded', 'draft', 'rename-requested']);
  assert.equal(again.loadSuccess(null), 0);
  assert.equal(again.displayModel().reason, 'none');
});
