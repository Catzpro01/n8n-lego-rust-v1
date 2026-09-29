/**
 * P2-S23 - AI Copilot surface pilot (issue #240, Layer 5).
 *
 * The strangler slice for the inline copilot suggestion surface split out of
 * P2-S03. Suggestions arrive as DECLARED AI capability events through hand-
 * over - the surface never applies a suggestion silently: no method writes a
 * status, accept/reject are declared with explicit results, and the outcome
 * arrives only via a fresh hand-over.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {suggestions}, no fetch,
 *         no workflow save, secret envelope refused, closed REGION_STATES +
 *         status/action/result vocabularies, never-silent-apply (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared request vocabularies, statuses never mutate (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCopilotSurface,
  copilotSurfaceContract,
  copilotActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  COPILOT_STATES,
  SUGGESTION_STATUSES,
  COPILOT_EMPTY_REASONS,
  COPILOT_ACTIONS,
  COPILOT_ACCEPT_RESULTS,
  COPILOT_REJECT_RESULTS,
  COPILOT_LABELS,
  COPILOT_A11Y,
  COPILOT_MAX_VISIBLE_DEFAULT,
  COPILOT_MAX_VISIBLE_HARD_MAX,
  SUGGESTION_TEXT_MAX_LENGTH,
  COPILOT_SURFACE_ID,
} from '../src/copilot.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const SUGGESTIONS = [
  { id: 's-1', target: 'node:if-branch', text: 'Split this branch into an error path.', status: 'pending' },
  { id: 's-2', target: 'workflow:trigger', text: 'Switch the trigger to a schedule.', status: 'pending' },
  { id: 's-3', target: 'node:http', text: 'Add a retry header.', status: 'accepted' },
  { id: 's-4', target: 'node:set', text: 'Rename the output field.', status: 'rejected' },
];

function loadedSurface(suggestions = SUGGESTIONS, options = {}) {
  const surface = createCopilotSurface(options);
  surface.loadSuccess({ suggestions });
  return surface;
}

const rowsSnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, target, text, status }) => ({ id, target, text, status })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = copilotSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, COPILOT_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.suggestionStatuses, SUGGESTION_STATUSES);
  assert.deepEqual(contract.vocabularies.actions, COPILOT_ACTIONS);
  assert.deepEqual(contract.vocabularies.acceptResults, COPILOT_ACCEPT_RESULTS);
  assert.deepEqual(contract.vocabularies.rejectResults, COPILOT_REJECT_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, COPILOT_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, COPILOT_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, COPILOT_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.textMaxLength, SUGGESTION_TEXT_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(COPILOT_STATES, REGION_STATES);
  assert.deepEqual(COPILOT_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(SUGGESTION_STATUSES, ['pending', 'accepted', 'rejected']);
  for (const vocab of [SUGGESTION_STATUSES, COPILOT_ACTIONS, COPILOT_ACCEPT_RESULTS, COPILOT_REJECT_RESULTS, COPILOT_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createCopilotSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly suggestions/);
  assert.throws(() => surface.loadSuccess({ suggestions: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ suggestions: 'no' }), /suggestions \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ suggestions: [{ id: 's', target: 't', text: 'x', status: 'pending', token: 'y' }] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ suggestions: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createCopilotSurface();
  assert.throws(() => surface.loadSuccess({ suggestions: ['s'] }), /suggestion 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ suggestions: [{ id: 's', target: 't', text: 'x', status: 'pending', extra: 1 }] }),
    /must have exactly id,target,text,status/,
  );
  assert.throws(
    () => surface.loadSuccess({ suggestions: [{ id: 's', target: 't', text: 'x', status: 'applied' }] }),
    /field status must be one of pending, accepted, rejected/,
  );
  assert.throws(
    () => surface.loadSuccess({ suggestions: [{ id: 's', target: 't', text: 'x'.repeat(SUGGESTION_TEXT_MAX_LENGTH + 1), status: 'pending' }] }),
    /field text must be at most/,
  );
  assert.throws(
    () => surface.loadSuccess({ suggestions: [{ id: 's', target: 't', text: 'a', status: 'pending' }, { id: 's', target: 'u', text: 'b', status: 'pending' }] }),
    /repeats the id/,
  );
});

test('A the surface holds no private data path and never applies a suggestion silently', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'copilot.mjs'));
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
  assert.equal(code.includes('EventSource'), false, 'the surface opens no stream itself');
  assert.equal(code.includes('WebSocket'), false, 'the surface opens no socket itself');
  const installs = code.match(/suggestions = Object\.freeze\(payload\.suggestions/g) ?? [];
  assert.equal(installs.length, 1, 'suggestions are installed in loadSuccess exactly once');
  const pushes = code.match(/suggestions\.push|\.suggestions\[/g) ?? [];
  assert.equal(pushes.length, 0, 'no method appends or indexes into the list - nothing is fabricated');
  const statusWrites = code.match(/\.status\s*=(?!=)/g) ?? [];
  assert.equal(statusWrites.length, 0, 'no status is ever written locally - the outcome arrives only via a fresh hand-over');
});

test('A the declared requests never change a status - the outcome arrives only as a fresh hand-over', () => {
  const surface = loadedSurface();
  const before = rowsSnapshot(surface);
  assert.equal(surface.requestAccept('s-1'), 'accepted');
  assert.equal(surface.requestReject('s-2'), 'accepted');
  assert.equal(rowsSnapshot(surface), before, 'id/target/text/status are byte-identical after every declared request');
  assert.equal(surface.suggestions.find((s) => s.id === 's-1').status, 'pending', 'accepting never flips the status here');
  // the outcome arrives as a fresh hand-over
  const decided = SUGGESTIONS.map((s) => (s.id === 's-1' ? { ...s, status: 'accepted' } : s));
  surface.loadSuccess({ suggestions: decided });
  assert.equal(surface.suggestions.find((s) => s.id === 's-1').status, 'accepted', 'only a fresh hand-over changes a status');
  assert.ok(COPILOT_ACCEPT_RESULTS.includes('invalid-state'), 'a decided suggestion is now a closed invalid-state');
  assert.equal(surface.requestAccept('s-1'), 'invalid-state');
  assert.ok(COPILOT_REJECT_RESULTS.includes('accepted'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.ai.copilot');
  assert.ok(entry, 'ui.ai.copilot is registered');
  assert.deepEqual(entry.surfaceIds, ['copilot']);
  assert.equal(entry.category, 'ai-surfaces');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S23');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/60-copilot.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest carries the copilot pilot capability and leaves the AI vocabulary declared', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'copilot');
  assert.ok(capability, 'copilot capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/copilot.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'copilot');
  assert.deepEqual(capability.surfaces, ['copilot']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/60-copilot.test.mjs']);
  assert.equal(capability.phase, 'P2-S23');
  // The pre-existing ai-copilot vocabulary capability stays untouched: the
  // six AI capabilities never claim an implementation (test/26 + A20).
  const declaredAi = manifest.capabilities.find((row) => row.id === 'ai-copilot');
  assert.equal(declaredAi.status, 'declared', 'the AI vocabulary capability claims nothing but a declaration');
  assert.equal(declaredAi.entry, undefined, 'the AI vocabulary capability names no implementation path');
  assert.deepEqual(declaredAi.surfaces, ['workflow-editor', 'node-picker'], 'the AI vocabulary surfaces are unchanged');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createCopilotSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createCopilotSurface();
  empty.loadSuccess({ suggestions: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createCopilotSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestAccept: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(COPILOT_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(COPILOT_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(COPILOT_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(COPILOT_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), COPILOT_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createCopilotSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), COPILOT_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['suggestion:s-1', 'suggestion:s-2'],
    'only pending suggestions are actionable and reachable, in hand-over order - decided ones are not hidden tab stops',
  );
  for (const key of ['accept', 'reject', 'refresh']) {
    assert.equal(typeof COPILOT_LABELS[key], 'string');
    assert.ok(COPILOT_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, COPILOT_LABELS, 'labels are declared once');
  surface.requestAccept('s-1');
  assert.equal(surface.displayModel().announcement, 's-1', 'the request announces the suggestion id');
  const allDecided = loadedSurface(SUGGESTIONS.map((s) => ({ ...s, status: 'accepted' })));
  assert.deepEqual(allDecided.displayModel().focusOrder, [], 'no suggestion is reachable once all are decided');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(copilotActionsFor('loading'), []);
  assert.deepEqual(copilotActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(copilotActionsFor('empty'), ['refresh']);
  assert.deepEqual(copilotActionsFor('ready'), ['refresh', 'request-accept', 'request-reject']);

  const loading = createCopilotSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createCopilotSurface();
  empty.loadSuccess({ suggestions: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'no suggestions offers only refresh');
  const failed = createCopilotSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded suggestion list: default cap, hard clamp and truncation reported', () => {
  const suggestions = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, target: `node:${i}`, text: `hint ${i}`, status: i % 3 ? 'pending' : 'accepted' }));
  const surface = loadedSurface(suggestions);
  assert.equal(surface.maxVisible, COPILOT_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, COPILOT_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createCopilotSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, COPILOT_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createCopilotSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createCopilotSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const suggestions = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, target: `node:${i}`, text: `suggestion ${i} - consider this change`, status: 'pending' }));
  const surface = createCopilotSurface({ maxVisible: COPILOT_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ suggestions });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 suggestions x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createCopilotSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ suggestions: SUGGESTIONS });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(SUGGESTIONS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestAccept('s-1');
  assert.equal(surface.degradedEvents, 2, 'the accept counted');
  surface.requestReject('s-2');
  assert.equal(surface.degradedEvents, 3, 'the reject counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createCopilotSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = rowsSnapshot(surface);
  // accept: unknown and decided are refused explicitly; pending is declared
  assert.equal(surface.requestAccept('s-ghost'), 'unknown-suggestion');
  assert.equal(surface.requestAccept('s-3'), 'invalid-state', 'an accepted suggestion cannot be accepted again');
  assert.equal(surface.requestAccept('s-4'), 'invalid-state', 'a rejected suggestion cannot be accepted');
  assert.equal(surface.requestAccept('s-1'), 'accepted');
  assert.throws(() => surface.requestAccept(' '), /non-empty suggestion id/);
  // reject: same closed rule
  assert.equal(surface.requestReject('s-ghost'), 'unknown-suggestion');
  assert.equal(surface.requestReject('s-3'), 'invalid-state');
  assert.equal(surface.requestReject('s-2'), 'accepted');
  assert.throws(() => surface.requestReject(7), /non-empty suggestion id/);
  // not-ready everywhere beyond refresh
  surface.setLoading();
  assert.equal(surface.requestAccept('s-1'), 'not-ready');
  assert.equal(surface.requestReject('s-2'), 'not-ready');
  // fresh hand-over replaces the view wholesale; records stay byte-identical
  surface.loadSuccess({ suggestions: SUGGESTIONS });
  assert.equal(rowsSnapshot(surface), before, 'id/target/text/status are byte-identical after every declared request');
  assert.equal(surface.displayModel().pendingCount, 2, 'two handed-over suggestions are pending');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ suggestions: [] });
  assert.equal(surface.displayModel().reason, 'none', 'no suggestions is empty with reason none');
  assert.equal(surface.requestAccept('s-1'), 'not-ready');
  assert.ok(COPILOT_ACCEPT_RESULTS.includes('unknown-suggestion'));
  assert.ok(COPILOT_REJECT_RESULTS.includes('invalid-state'));
  for (const action of COPILOT_ACTIONS) assert.ok(COPILOT_ACTIONS.includes(action));
});
