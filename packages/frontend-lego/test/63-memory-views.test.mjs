/**
 * P2-S26 - Memory/Context/Session views surface pilot (issue #240, Layer 5).
 *
 * The strangler slice for the memory, context and session inspection
 * surfaces split out of P2-S03. The session state is handed over through
 * the session capability - the surface is READ-ONLY: no fetch, no direct
 * session store access, no mutation of a record, no write of any kind.
 * request-open-entry is declared with explicit results and the capability
 * that owns navigation performs it.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {memory, context, session},
 *         read-only, no fetch, no workflow save, secret envelope refused,
 *         closed REGION_STATES + kind/status/action/result vocabularies (A)
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
  createMemoryViewsSurface,
  memoryViewsSurfaceContract,
  memoryViewsActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  MEMORY_VIEWS_STATES,
  MEMORY_KINDS,
  SESSION_STATUSES,
  MEMORY_VIEWS_EMPTY_REASONS,
  MEMORY_VIEWS_ACTIONS,
  MEMORY_VIEWS_OPEN_RESULTS,
  MEMORY_VIEWS_LABELS,
  MEMORY_VIEWS_A11Y,
  MEMORY_VIEWS_MAX_VISIBLE_DEFAULT,
  MEMORY_VIEWS_MAX_VISIBLE_HARD_MAX,
  MEMORY_TEXT_MAX_LENGTH,
  MEMORY_VIEWS_SURFACE_ID,
} from '../src/memory-views.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const MEMORY = [
  { id: 'm-1', kind: 'short-term', text: 'User prefers concise answers' },
  { id: 'm-2', kind: 'retrieved', text: 'Invoice schema: {id, total, dueDate}' },
  { id: 'm-3', kind: 'long-term', text: 'Project ships on the 2.9.4 editor line' },
  { id: 'm-4', kind: 'short-term', text: 'Retry budget is three attempts' },
];
const CONTEXT = { used: 1200, limit: 8000 };
const SESSION = { id: 's-2026-09-29-a', turns: 7, status: 'active' };

function loadedSurface(memory = MEMORY, options = {}) {
  const surface = createMemoryViewsSurface(options);
  surface.loadSuccess({ memory, context: CONTEXT, session: SESSION });
  return surface;
}

const entrySnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, kind, text }) => ({ id, kind, text })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = memoryViewsSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, MEMORY_VIEWS_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.memoryKinds, MEMORY_KINDS);
  assert.deepEqual(contract.vocabularies.sessionStatuses, SESSION_STATUSES);
  assert.deepEqual(contract.vocabularies.actions, MEMORY_VIEWS_ACTIONS);
  assert.deepEqual(contract.vocabularies.openResults, MEMORY_VIEWS_OPEN_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, MEMORY_VIEWS_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, MEMORY_VIEWS_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, MEMORY_VIEWS_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.textMaxLength, MEMORY_TEXT_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(MEMORY_VIEWS_STATES, REGION_STATES);
  assert.deepEqual(MEMORY_VIEWS_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(MEMORY_KINDS, ['short-term', 'long-term', 'retrieved']);
  assert.deepEqual(SESSION_STATUSES, ['active', 'idle', 'closed']);
  for (const vocab of [MEMORY_KINDS, SESSION_STATUSES, MEMORY_VIEWS_ACTIONS, MEMORY_VIEWS_OPEN_RESULTS, MEMORY_VIEWS_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createMemoryViewsSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly memory,context,session/);
  assert.throws(() => surface.loadSuccess({ memory: [], context: CONTEXT, session: SESSION, extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ memory: 'no', context: CONTEXT, session: SESSION }), /memory \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ memory: [{ id: 'm', kind: 'short-term', text: 'x', token: 'y' }], context: CONTEXT, session: SESSION }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ memory: [], context: CONTEXT, session: SESSION, sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createMemoryViewsSurface();
  const base = { context: CONTEXT, session: SESSION };
  assert.throws(() => surface.loadSuccess({ ...base, memory: ['m'] }), /memory item 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ ...base, memory: [{ id: 'm', kind: 'short-term', text: 'x', extra: 1 }] }),
    /must have exactly id,kind,text/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, memory: [{ id: 'm', kind: 'mystery', text: 'x' }] }),
    /field kind must be one of short-term, long-term, retrieved/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, memory: [{ id: 'm', kind: 'short-term', text: 'x'.repeat(MEMORY_TEXT_MAX_LENGTH + 1) }] }),
    /field text must be at most/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, memory: [{ id: 'm', kind: 'short-term', text: 'a' }, { id: 'm', kind: 'long-term', text: 'b' }] }),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess({ memory: [], context: { used: 1 }, session: SESSION }),
    /context must have exactly limit,used/,
  );
  assert.throws(
    () => surface.loadSuccess({ memory: [], context: { used: 9000, limit: 8000 }, session: SESSION }),
    /used must not exceed limit/,
  );
  assert.throws(
    () => surface.loadSuccess({ memory: [], context: CONTEXT, session: { id: 's', status: 'ghost', turns: 1 } }),
    /field status must be one of active, idle, closed/,
  );
  assert.throws(
    () => surface.loadSuccess({ memory: [], context: CONTEXT, session: { id: 's', status: 'active', turns: -1 } }),
    /field turns must be an integer/,
  );
});

test('A the surface is read-only: loadSuccess is the only entry, no fetch, no evaluator, no writes', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'memory-views.mjs'));
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
  const installs = code.match(/memory = Object\.freeze\(payload\.memory/g) ?? [];
  assert.equal(installs.length, 1, 'the memory is installed in loadSuccess exactly once');
  const fieldWrites = code.match(/\.(kind|text|used|limit|turns|status)\s*=(?!=)/g) ?? [];
  assert.equal(fieldWrites.length, 0, 'no record field is ever written locally - the surface is read-only');
});

test('A the declared open never mutates the records - read-only holds for every request', () => {
  const surface = loadedSurface();
  const before = entrySnapshot(surface);
  assert.equal(surface.requestOpenEntry('m-3'), 'accepted');
  assert.equal(surface.requestOpenEntry('m-ghost'), 'unknown-entry');
  assert.equal(entrySnapshot(surface), before, 'id/kind/text are byte-identical after every declared request');
  assert.equal(surface.memory.length, MEMORY.length, 'nothing was appended or removed');
  surface.loadSuccess({ memory: MEMORY, context: CONTEXT, session: SESSION });
  assert.equal(entrySnapshot(surface), before, 'a fresh hand-over yields the same read-only records');
  assert.ok(MEMORY_VIEWS_OPEN_RESULTS.includes('accepted'));
  assert.ok(MEMORY_VIEWS_OPEN_RESULTS.includes('unknown-entry'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.memory.views');
  assert.ok(entry, 'ui.memory.views is registered');
  assert.deepEqual(entry.surfaceIds, ['memory-views']);
  assert.equal(entry.category, 'memory-session-views');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S26');
  assert.deepEqual(entry.dependencies, []);
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/63-memory-views.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the memory-views capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'memory-views');
  assert.ok(capability, 'memory-views capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/memory-views.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'memory-views');
  assert.deepEqual(capability.surfaces, ['memory-views']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/63-memory-views.test.mjs']);
  assert.equal(capability.phase, 'P2-S26');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createMemoryViewsSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createMemoryViewsSurface();
  empty.loadSuccess({ memory: [], context: CONTEXT, session: SESSION });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createMemoryViewsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestOpenEntry: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(MEMORY_VIEWS_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(MEMORY_VIEWS_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(MEMORY_VIEWS_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(MEMORY_VIEWS_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), MEMORY_VIEWS_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createMemoryViewsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), MEMORY_VIEWS_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['view:session', 'view:context', 'entry:m-1', 'entry:m-2', 'entry:m-3', 'entry:m-4'],
    'the two inspection views lead, then every memory entry in hand-over order, rows never reorder',
  );
  for (const key of ['open', 'refresh']) {
    assert.equal(typeof MEMORY_VIEWS_LABELS[key], 'string');
    assert.ok(MEMORY_VIEWS_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, MEMORY_VIEWS_LABELS, 'labels are declared once');
  surface.requestOpenEntry('m-3');
  assert.equal(surface.displayModel().announcement, 'm-3', 'the request announces the entry id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(memoryViewsActionsFor('loading'), []);
  assert.deepEqual(memoryViewsActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(memoryViewsActionsFor('empty'), ['refresh']);
  assert.deepEqual(memoryViewsActionsFor('ready'), ['refresh', 'request-open-entry']);

  const loading = createMemoryViewsSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createMemoryViewsSurface();
  empty.loadSuccess({ memory: [], context: CONTEXT, session: SESSION });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty inspection offers only refresh');
  const failed = createMemoryViewsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded memory window: default cap, hard clamp and truncation reported', () => {
  const memory = Array.from({ length: 45 }, (_, i) => ({ id: `m${i}`, kind: MEMORY_KINDS[i % 3], text: `entry ${i}` }));
  const surface = loadedSurface(memory);
  assert.equal(surface.maxVisible, MEMORY_VIEWS_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, MEMORY_VIEWS_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 45);
  assert.equal(model.shown[0].id, 'm15', 'the window keeps the newest entries');

  const wide = createMemoryViewsSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, MEMORY_VIEWS_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createMemoryViewsSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createMemoryViewsSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const memory = Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, kind: MEMORY_KINDS[i % 3], text: `entry ${i}` }));
  const surface = createMemoryViewsSurface({ maxVisible: MEMORY_VIEWS_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ memory, context: CONTEXT, session: SESSION });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 entries x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createMemoryViewsSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ memory: MEMORY, context: CONTEXT, session: SESSION });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(MEMORY, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestOpenEntry('m-1');
  assert.equal(surface.degradedEvents, 2, 'the open counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createMemoryViewsSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = entrySnapshot(surface);
  // request-open-entry: closed vocabulary
  assert.equal(surface.requestOpenEntry('m-ghost'), 'unknown-entry');
  assert.equal(surface.requestOpenEntry('m-2'), 'accepted');
  assert.throws(() => surface.requestOpenEntry(' '), /non-empty entry id/);
  // not-ready beyond refresh
  surface.setLoading();
  assert.equal(surface.requestOpenEntry('m-2'), 'not-ready');
  // fresh hand-over: read-only, byte-identical
  surface.loadSuccess({ memory: MEMORY, context: CONTEXT, session: SESSION });
  assert.equal(entrySnapshot(surface), before, 'id/kind/text are byte-identical after every declared request');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ memory: [], context: CONTEXT, session: SESSION });
  assert.equal(surface.displayModel().reason, 'none', 'no entries is empty with reason none');
  assert.equal(surface.requestOpenEntry('m-2'), 'not-ready');
  assert.ok(MEMORY_VIEWS_OPEN_RESULTS.includes('unknown-entry'));
  assert.ok(MEMORY_VIEWS_OPEN_RESULTS.includes('not-ready'));
  for (const action of MEMORY_VIEWS_ACTIONS) assert.ok(MEMORY_VIEWS_ACTIONS.includes(action));
});
