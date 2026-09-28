/**
 * P2-S22 - AI Assistant surface pilot (issue #240, Layer 5).
 *
 * The strangler slice for the conversational assistant surface split out of
 * P2-S03. Assistant turns are handed over as EVENTS - the surface never
 * fabricates assistant output: no method writes a turn, no method invents a
 * reply, and no inference/provider client exists here. request-send /
 * request-stop-stream are declared with explicit results, and the reply
 * arrives only via a fresh hand-over.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {turns, streaming}, no
 *         fetch, no workflow save, secret envelope refused, closed
 *         REGION_STATES + role/action/result vocabularies, never fabricates
 *         (A)
 *   CP-02 pilot mode + rollback: manifest conversion pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         declared request vocabularies, turns never mutate (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAiAssistantSurface,
  aiAssistantSurfaceContract,
  aiAssistantActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  AI_ASSISTANT_STATES,
  TURN_ROLES,
  AI_ASSISTANT_EMPTY_REASONS,
  AI_ASSISTANT_ACTIONS,
  AI_ASSISTANT_SEND_RESULTS,
  AI_ASSISTANT_STOP_STREAM_RESULTS,
  AI_ASSISTANT_LABELS,
  AI_ASSISTANT_A11Y,
  AI_ASSISTANT_MAX_VISIBLE_DEFAULT,
  AI_ASSISTANT_MAX_VISIBLE_HARD_MAX,
  TURN_TEXT_MAX_LENGTH,
  SEND_TEXT_MAX_LENGTH,
  AI_ASSISTANT_SURFACE_ID,
} from '../src/ai-assistant.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const TURNS = [
  { id: 't-1', role: 'user', text: 'How do I retry a failed run?' },
  { id: 't-2', role: 'assistant', text: 'Open the execution and use the retry action.' },
  { id: 't-3', role: 'user', text: 'And for a running one?' },
];

function loadedSurface(turns = TURNS, streaming = false, options = {}) {
  const surface = createAiAssistantSurface(options);
  surface.loadSuccess({ turns, streaming });
  return surface;
}

const turnsSnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, role, text }) => ({ id, role, text })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = aiAssistantSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, AI_ASSISTANT_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.turnRoles, TURN_ROLES);
  assert.deepEqual(contract.vocabularies.actions, AI_ASSISTANT_ACTIONS);
  assert.deepEqual(contract.vocabularies.sendResults, AI_ASSISTANT_SEND_RESULTS);
  assert.deepEqual(contract.vocabularies.stopStreamResults, AI_ASSISTANT_STOP_STREAM_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, AI_ASSISTANT_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, AI_ASSISTANT_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, AI_ASSISTANT_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.turnTextMaxLength, TURN_TEXT_MAX_LENGTH);
  assert.equal(contract.bounds.sendTextMaxLength, SEND_TEXT_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(AI_ASSISTANT_STATES, REGION_STATES);
  assert.deepEqual(AI_ASSISTANT_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(TURN_ROLES, ['user', 'assistant']);
  for (const vocab of [TURN_ROLES, AI_ASSISTANT_ACTIONS, AI_ASSISTANT_SEND_RESULTS, AI_ASSISTANT_STOP_STREAM_RESULTS, AI_ASSISTANT_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createAiAssistantSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly turns,streaming/);
  assert.throws(() => surface.loadSuccess({ turns: [], streaming: false, extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ turns: 'no', streaming: false }), /turns \(array\)/);
  assert.throws(() => surface.loadSuccess({ turns: [], streaming: 'yes' }), /streaming \(boolean\)/);
  assert.throws(
    () => surface.loadSuccess({ turns: [{ id: 't', role: 'user', text: 'hi', token: 'x' }], streaming: false }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ turns: [], streaming: false, sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createAiAssistantSurface();
  assert.throws(() => surface.loadSuccess({ turns: ['t'], streaming: false }), /turn 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ turns: [{ id: 't', role: 'user', text: 'hi', extra: 1 }], streaming: false }),
    /must have exactly id,role,text/,
  );
  assert.throws(
    () => surface.loadSuccess({ turns: [{ id: 't', role: 'system', text: 'hi' }], streaming: false }),
    /field role must be one of user, assistant/,
  );
  assert.throws(
    () => surface.loadSuccess({ turns: [{ id: 't', role: 'user', text: 'x'.repeat(TURN_TEXT_MAX_LENGTH + 1) }], streaming: false }),
    /field text must be at most/,
  );
  assert.throws(
    () => surface.loadSuccess({ turns: [{ id: 't', role: 'user', text: 'a' }, { id: 't', role: 'assistant', text: 'b' }], streaming: false }),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess({ turns: [{ id: 't', role: 'user', text: '' }], streaming: false }),
    /field text must be a non-empty string/,
  );
});

test('A the surface holds no private data path and never fabricates assistant output', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'ai-assistant.mjs'));
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
  const installs = code.match(/turns = Object\.freeze\(payload\.turns/g) ?? [];
  assert.equal(installs.length, 1, 'turns are installed in loadSuccess exactly once');
  const pushes = code.match(/turns\.push|\.turns\[/g) ?? [];
  assert.equal(pushes.length, 0, 'no method appends or indexes into the turn list - nothing is fabricated');
  const turnWrites = code.match(/\.(role|text)\s*=(?!=)/g) ?? [];
  assert.equal(turnWrites.length, 0, 'no turn field is ever written locally - a reply arrives only via a fresh hand-over');
});

test('A the declared requests never create a turn - the reply arrives only as a fresh hand-over', () => {
  const surface = loadedSurface();
  const before = turnsSnapshot(surface);
  assert.equal(surface.requestSend('How about bulk?'), 'accepted');
  assert.equal(surface.requestStopStream(), 'not-streaming', 'nothing is streaming after this hand-over');
  assert.equal(turnsSnapshot(surface), before, 'id/role/text are byte-identical after every declared request');
  assert.equal(surface.turns.length, TURNS.length, 'no turn was appended by request-send');
  // the reply arrives as a fresh hand-over, replacing the view wholesale
  const reply = [...TURNS, { id: 't-4', role: 'assistant', text: 'Bulk actions live in the executions panel.' }];
  surface.loadSuccess({ turns: reply, streaming: false });
  assert.equal(surface.turns.length, 4, 'only a fresh hand-over changes the conversation');
  assert.ok(AI_ASSISTANT_SEND_RESULTS.includes('accepted'));
  assert.ok(AI_ASSISTANT_STOP_STREAM_RESULTS.includes('not-streaming'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the converted pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.ai.assistant');
  assert.ok(entry, 'ui.ai.assistant is registered');
  assert.deepEqual(entry.surfaceIds, ['assistant']);
  assert.equal(entry.category, 'ai-surfaces');
  assert.equal(entry.migrationStatus, 'pilot-available', 'the reference-only row converts to a pilot');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S22');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/59-ai-assistant.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest carries the assistant pilot capability and leaves the AI vocabulary declared', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'assistant');
  assert.ok(capability, 'assistant capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/ai-assistant.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'assistant');
  assert.deepEqual(capability.surfaces, ['assistant']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/59-ai-assistant.test.mjs']);
  assert.equal(capability.phase, 'P2-S22');
  // The six AI vocabulary capabilities never claim an implementation: the
  // pre-existing ai-assistant declaration stays untouched (status declared,
  // no entry module) - the pilot ships beside it, not instead of it.
  const declaredAi = manifest.capabilities.find((row) => row.id === 'ai-assistant');
  assert.equal(declaredAi.status, 'declared', 'the AI vocabulary capability claims nothing but a declaration');
  assert.equal(declaredAi.entry, undefined, 'the AI vocabulary capability names no implementation path');
  assert.deepEqual(declaredAi.surfaces, ['dialogs', 'navigation'], 'the AI vocabulary surfaces are unchanged');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createAiAssistantSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createAiAssistantSurface();
  empty.loadSuccess({ turns: [], streaming: false });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createAiAssistantSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestSend: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(AI_ASSISTANT_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(AI_ASSISTANT_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(AI_ASSISTANT_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(AI_ASSISTANT_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), AI_ASSISTANT_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createAiAssistantSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), AI_ASSISTANT_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface(TURNS, true);
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['composer', 'send', 'stop-stream'],
    'the composer, send and (while streaming) stop are reachable; turns are content, not controls',
  );
  assert.equal(surface.loadSuccess({ turns: TURNS, streaming: false }), TURNS.length);
  assert.deepEqual(
    surface.displayModel().focusOrder,
    ['composer', 'send'],
    'without streaming the stop control drops out - never a hidden tab stop',
  );
  for (const key of ['composer', 'send', 'stopStream', 'refresh']) {
    assert.equal(typeof AI_ASSISTANT_LABELS[key], 'string');
    assert.ok(AI_ASSISTANT_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, AI_ASSISTANT_LABELS, 'labels are declared once');
  const sending = loadedSurface();
  sending.requestSend('next question');
  assert.equal(sending.displayModel().announcement, 'sent', 'the send announces its declared outcome');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(aiAssistantActionsFor('loading'), []);
  assert.deepEqual(aiAssistantActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(aiAssistantActionsFor('empty'), ['refresh']);
  assert.deepEqual(aiAssistantActionsFor('ready'), ['refresh', 'request-send', 'request-stop-stream']);

  const loading = createAiAssistantSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createAiAssistantSurface();
  empty.loadSuccess({ turns: [], streaming: false });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty conversation offers only refresh');
  const failed = createAiAssistantSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded turn window: default cap, hard clamp and truncation reported', () => {
  const turns = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', text: `line ${i}` }));
  const surface = loadedSurface(turns);
  assert.equal(surface.maxVisible, AI_ASSISTANT_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, AI_ASSISTANT_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);
  assert.equal(model.shown[0].id, 't30', 'the window keeps the newest turns');

  const wide = createAiAssistantSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, AI_ASSISTANT_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createAiAssistantSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createAiAssistantSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const turns = Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, role: i % 2 ? 'assistant' : 'user', text: `turn ${i} - what happens next?` }));
  const surface = createAiAssistantSurface({ maxVisible: AI_ASSISTANT_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ turns, streaming: false });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 turns x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createAiAssistantSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ turns: TURNS, streaming: false });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(TURNS, false, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestSend('hello');
  assert.equal(surface.degradedEvents, 2, 'the send counted');
  surface.loadSuccess({ turns: TURNS, streaming: true });
  assert.equal(surface.degradedEvents, 3, 'the streaming hand-over counted');
  surface.requestStopStream();
  assert.equal(surface.degradedEvents, 4, 'the stop counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createAiAssistantSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = turnsSnapshot(surface);
  // request-send: closed composer rule
  assert.equal(surface.requestSend(''), 'invalid-text', 'empty is refused');
  assert.equal(surface.requestSend('   '), 'invalid-text', 'whitespace-only is refused');
  assert.equal(surface.requestSend('x'.repeat(SEND_TEXT_MAX_LENGTH + 1)), 'invalid-text', 'over the bound is refused');
  assert.equal(surface.requestSend('Why did step 2 fail?'), 'accepted');
  assert.throws(() => surface.requestSend(42), /expects a text string/);
  // request-stop-stream: gated on the handed-over streaming flag
  assert.equal(surface.requestStopStream(), 'not-streaming', 'streaming is handed over, never toggled locally');
  surface.loadSuccess({ turns: TURNS, streaming: true });
  assert.equal(surface.streaming, true, 'the flag comes from the hand-over');
  assert.equal(surface.requestStopStream(), 'accepted');
  assert.equal(surface.streaming, true, 'requesting a stop never flips the flag locally');
  // not-ready everywhere beyond refresh
  surface.setLoading();
  assert.equal(surface.requestSend('x'), 'not-ready');
  assert.equal(surface.requestStopStream(), 'not-ready');
  // fresh hand-over replaces the conversation wholesale; records stay byte-identical
  surface.loadSuccess({ turns: TURNS, streaming: false });
  assert.equal(turnsSnapshot(surface), before, 'id/role/text are byte-identical after every declared request');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ turns: [], streaming: false });
  assert.equal(surface.displayModel().reason, 'none', 'an empty conversation is empty with reason none');
  assert.equal(surface.requestSend('x'), 'not-ready');
  assert.ok(AI_ASSISTANT_SEND_RESULTS.includes('invalid-text'));
  assert.ok(AI_ASSISTANT_STOP_STREAM_RESULTS.includes('not-streaming'));
  for (const action of AI_ASSISTANT_ACTIONS) assert.ok(AI_ASSISTANT_ACTIONS.includes(action));
});
