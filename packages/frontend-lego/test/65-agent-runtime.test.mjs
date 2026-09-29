/**
 * P2-S28 - Agent/Runtime views surface pilot (issue #240, Layer 5).
 *
 * The strangler slice for the agent and runtime supervision surfaces split
 * out of P2-S03. The supervision snapshot is handed over through the
 * capability registry - the surface is READ-ONLY AND CANNOT START OR STOP
 * RUNTIMES (or pause/resume/cancel anything): no fetch, no runtime/agent
 * operation, no mutation of a record. request-open-agent is declared with
 * explicit results and the capability that owns navigation performs it.
 * Vocabularies are quoted: agentSessionState (7 states) and
 * agentEventType (26 types) from vocabulary.mjs - no local vocabulary.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {agents, events},
 *         read-only, no control verbs, no fetch, no workflow save, secret
 *         envelope refused, closed REGION_STATES + status/type/action/
 *         result vocabularies (A)
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
  createAgentRuntimeSurface,
  agentRuntimeSurfaceContract,
  agentRuntimeActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  AGENT_RUNTIME_STATES,
  AGENT_SESSION_STATES,
  AGENT_EVENT_TYPES,
  AGENT_RUNTIME_EMPTY_REASONS,
  AGENT_RUNTIME_ACTIONS,
  AGENT_RUNTIME_OPEN_RESULTS,
  AGENT_RUNTIME_LABELS,
  AGENT_RUNTIME_A11Y,
  AGENT_RUNTIME_MAX_VISIBLE_DEFAULT,
  AGENT_RUNTIME_MAX_VISIBLE_HARD_MAX,
  AGENT_SUMMARY_MAX_LENGTH,
  AGENT_RUNTIME_SURFACE_ID,
} from '../src/agent-runtime.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const AGENTS = [
  { agentId: 'ag-1', runtimeId: 'rt-1', status: 'running' },
  { agentId: 'ag-2', runtimeId: 'rt-1', status: 'waiting' },
  { agentId: 'ag-3', runtimeId: 'rt-2', status: 'completed' },
];
const EVENTS = [
  { eventId: 'ev-1', timestamp: '2026-09-28T10:00:00Z', type: 'agent.started', agentId: 'ag-1', summary: 'session started' },
  { eventId: 'ev-2', timestamp: '2026-09-28T10:00:05Z', type: 'tool.completed', agentId: 'ag-1', summary: 'tool finished' },
  { eventId: 'ev-3', timestamp: '2026-09-28T10:00:09Z', type: 'runtime.connected', agentId: 'ag-2', summary: 'runtime attached' },
  { eventId: 'ev-4', timestamp: '2026-09-28T10:00:12Z', type: 'decision.approved', agentId: 'ag-3', summary: 'plan approved' },
];

function loadedSurface(agents = AGENTS, events = EVENTS, options = {}) {
  const surface = createAgentRuntimeSurface(options);
  surface.loadSuccess({ agents, events });
  return surface;
}

const agentSnapshot = (surface) => JSON.stringify(
  surface.displayModel().agents.map(({ agentId, runtimeId, status }) => ({ agentId, runtimeId, status })),
);
const eventSnapshot = (surface) => JSON.stringify(
  surface.events.map(({ eventId, timestamp, type, agentId, summary }) => ({ eventId, timestamp, type, agentId, summary })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = agentRuntimeSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, AGENT_RUNTIME_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.agentStatuses, AGENT_SESSION_STATES);
  assert.deepEqual(contract.vocabularies.eventTypes, AGENT_EVENT_TYPES);
  assert.deepEqual(contract.vocabularies.actions, AGENT_RUNTIME_ACTIONS);
  assert.deepEqual(contract.vocabularies.openResults, AGENT_RUNTIME_OPEN_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, AGENT_RUNTIME_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, AGENT_RUNTIME_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, AGENT_RUNTIME_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.summaryMaxLength, AGENT_SUMMARY_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES and the vocabularies are quoted', () => {
  assert.deepEqual(AGENT_RUNTIME_STATES, REGION_STATES);
  assert.deepEqual(AGENT_RUNTIME_STATES, ['loading', 'empty', 'error', 'ready']);
  // QUOTED, never redefined: the surface has no vocabulary of its own.
  assert.deepEqual(AGENT_SESSION_STATES, ['created', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']);
  assert.equal(AGENT_EVENT_TYPES.length, 26, 'the 26 locked agent event types, verbatim');
  assert.ok(AGENT_EVENT_TYPES.includes('runtime.connected'));
  assert.ok(AGENT_EVENT_TYPES.includes('runtime.disconnected'));
  assert.ok(AGENT_EVENT_TYPES.includes('agent.started'));
  for (const vocab of [AGENT_SESSION_STATES, AGENT_EVENT_TYPES, AGENT_RUNTIME_ACTIONS, AGENT_RUNTIME_OPEN_RESULTS, AGENT_RUNTIME_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createAgentRuntimeSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly agents,events/);
  assert.throws(() => surface.loadSuccess({ agents: [], events: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ agents: 'no', events: [] }), /agents \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ agents: [{ agentId: 'ag', runtimeId: 'rt', status: 'running', token: 'y' }], events: [] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ agents: [], events: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createAgentRuntimeSurface();
  const base = { agents: [], events: [] };
  assert.throws(() => surface.loadSuccess({ ...base, agents: ['a'] }), /agent 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ ...base, agents: [{ agentId: 'ag', runtimeId: 'rt', status: 'running', extra: 1 }] }),
    /must have exactly agentId,runtimeId,status/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, agents: [{ agentId: 'ag', runtimeId: 'rt', status: 'ghost' }] }),
    /field status must be one of created, running, waiting/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, agents: [{ agentId: 'ag', runtimeId: 'rt', status: 'running' }, { agentId: 'ag', runtimeId: 'rt', status: 'paused' }] }),
    /repeats the agentId/,
  );
  assert.throws(
    () => surface.loadSuccess({ agents: [], events: [{ eventId: 'ev', timestamp: '2026-09-28T10:00:00Z', type: 'ghost.type', agentId: 'ag', summary: 'x' }] }),
    /field type must be one of the locked agentEventType/,
  );
  assert.throws(
    () => surface.loadSuccess({ agents: [], events: [{ eventId: 'ev', timestamp: 'yesterday', type: 'agent.started', agentId: 'ag', summary: 'x' }] }),
    /ISO 8601 timestamp/,
  );
  assert.throws(
    () => surface.loadSuccess({ agents: [], events: [{ eventId: 'ev', timestamp: '2026-09-28T10:00:00Z', type: 'agent.started', agentId: 'ag', summary: 'x'.repeat(AGENT_SUMMARY_MAX_LENGTH + 1) }] }),
    /field summary must be at most/,
  );
  assert.throws(
    () => surface.loadSuccess({ agents: [], events: [{ eventId: 'ev', timestamp: '2026-09-28T10:00:00Z', type: 'agent.started', agentId: 'ag', summary: 'a' }, { eventId: 'ev', timestamp: '2026-09-28T10:00:01Z', type: 'agent.started', agentId: 'ag', summary: 'b' }] }),
    /repeats the eventId/,
  );
});

test('A the surface cannot start or stop runtimes: no control verb exists, loadSuccess is the only entry, no fetch, no evaluator, no writes', () => {
  for (const verb of ['start', 'stop', 'pause', 'resume', 'cancel']) {
    assert.equal(AGENT_RUNTIME_ACTIONS.includes(verb), false, `no ${verb} action exists`);
    assert.equal(AGENT_RUNTIME_ACTIONS.includes(`request-${verb}`), false, `no request-${verb} exists`);
  }
  const source = read(join(PACKAGE_ROOT, 'src', 'agent-runtime.mjs'));
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
  assert.equal(installs.length, 1, 'the events are installed in loadSuccess exactly once');
  const fieldWrites = code.match(/\.(agentId|status|type|summary)\s*=(?!=)/g) ?? [];
  assert.equal(fieldWrites.length, 0, 'no record field is ever written locally - the surface is read-only');
  const control = code.match(/\b(grant|start|stop|pause|resume|cancel)\w*\s*\(/g) ?? [];
  assert.equal(control.length, 0, 'no runtime/agent control call exists in this surface');
});

test('A the declared open never mutates the records - read-only holds for every request', () => {
  const surface = loadedSurface();
  const agentBefore = agentSnapshot(surface);
  const eventBefore = eventSnapshot(surface);
  assert.equal(surface.requestOpenAgent('ag-2'), 'accepted');
  assert.equal(surface.requestOpenAgent('ag-ghost'), 'unknown-agent');
  assert.equal(agentSnapshot(surface), agentBefore, 'agentId/runtimeId/status are byte-identical after every declared request');
  assert.equal(eventSnapshot(surface), eventBefore, 'the event stream is byte-identical after every declared request');
  surface.loadSuccess({ agents: AGENTS, events: EVENTS });
  assert.equal(agentSnapshot(surface), agentBefore, 'a fresh hand-over yields the same read-only records');
  assert.equal(eventSnapshot(surface), eventBefore, 'a fresh hand-over yields the same event stream');
  assert.ok(AGENT_RUNTIME_OPEN_RESULTS.includes('accepted'));
  assert.ok(AGENT_RUNTIME_OPEN_RESULTS.includes('unknown-agent'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.agent.runtime');
  assert.ok(entry, 'ui.agent.runtime is registered');
  assert.deepEqual(entry.surfaceIds, ['agent-runtime']);
  assert.equal(entry.category, 'ai-surfaces');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S28');
  assert.deepEqual(entry.dependencies, []);
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/65-agent-runtime.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the agent-runtime capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'agent-runtime');
  assert.ok(capability, 'agent-runtime capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/agent-runtime.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'agent-runtime');
  assert.deepEqual(capability.surfaces, ['agent-runtime']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/65-agent-runtime.test.mjs']);
  assert.equal(capability.phase, 'P2-S28');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createAgentRuntimeSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createAgentRuntimeSurface();
  empty.loadSuccess({ agents: [], events: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createAgentRuntimeSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestOpenAgent: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(AGENT_RUNTIME_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(AGENT_RUNTIME_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(AGENT_RUNTIME_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(AGENT_RUNTIME_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), AGENT_RUNTIME_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createAgentRuntimeSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), AGENT_RUNTIME_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['view:agents', 'view:events', 'agent:ag-1', 'agent:ag-2', 'agent:ag-3', 'event:ev-1', 'event:ev-2', 'event:ev-3', 'event:ev-4'],
    'the two views lead, then agents then events in hand-over order, rows never reorder',
  );
  for (const key of ['open', 'refresh', 'agents', 'events']) {
    assert.equal(typeof AGENT_RUNTIME_LABELS[key], 'string');
    assert.ok(AGENT_RUNTIME_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, AGENT_RUNTIME_LABELS, 'labels are declared once');
  surface.requestOpenAgent('ag-2');
  assert.equal(surface.displayModel().announcement, 'ag-2', 'the request announces the agent id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(agentRuntimeActionsFor('loading'), []);
  assert.deepEqual(agentRuntimeActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(agentRuntimeActionsFor('empty'), ['refresh']);
  assert.deepEqual(agentRuntimeActionsFor('ready'), ['refresh', 'request-open-agent']);

  const loading = createAgentRuntimeSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createAgentRuntimeSurface();
  empty.loadSuccess({ agents: [], events: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty view offers only refresh');
  const failed = createAgentRuntimeSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded event window: default cap, hard clamp and truncation reported', () => {
  const events = Array.from({ length: 45 }, (_, i) => ({
    eventId: `ev${i}`,
    timestamp: `2026-09-28T10:00:${String(i).padStart(2, '0')}Z`,
    type: AGENT_EVENT_TYPES[i % 26],
    agentId: `ag-${i % 3}`,
    summary: `event ${i}`,
  }));
  const surface = loadedSurface(AGENTS, events);
  assert.equal(surface.maxVisible, AGENT_RUNTIME_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, AGENT_RUNTIME_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 45);
  assert.equal(model.shown[0].eventId, 'ev15', 'the window keeps the newest events');
  assert.equal(model.agentCount, AGENTS.length, 'the agent list is shown in full');

  const wide = createAgentRuntimeSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, AGENT_RUNTIME_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createAgentRuntimeSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createAgentRuntimeSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const events = Array.from({ length: 200 }, (_, i) => ({
    eventId: `ev${i}`,
    timestamp: `2026-09-28T10:00:${String(i % 60).padStart(2, '0')}Z`,
    type: AGENT_EVENT_TYPES[i % 26],
    agentId: `ag-${i % 5}`,
    summary: `event ${i}`,
  }));
  const surface = createAgentRuntimeSurface({ maxVisible: AGENT_RUNTIME_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ agents: AGENTS, events });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 events x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createAgentRuntimeSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ agents: AGENTS, events: EVENTS });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(AGENTS, EVENTS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestOpenAgent('ag-1');
  assert.equal(surface.degradedEvents, 2, 'the open counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createAgentRuntimeSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = agentSnapshot(surface);
  // request-open-agent: closed vocabulary
  assert.equal(surface.requestOpenAgent('ag-ghost'), 'unknown-agent');
  assert.equal(surface.requestOpenAgent('ag-1'), 'accepted');
  assert.throws(() => surface.requestOpenAgent(' '), /non-empty agent id/);
  // not-ready beyond refresh
  surface.setLoading();
  assert.equal(surface.requestOpenAgent('ag-1'), 'not-ready');
  // fresh hand-over: read-only, byte-identical
  surface.loadSuccess({ agents: AGENTS, events: EVENTS });
  assert.equal(agentSnapshot(surface), before, 'agentId/runtimeId/status are byte-identical after every declared request');
  // empty region refuses everything beyond refresh; a non-empty half is ready
  surface.loadSuccess({ agents: [], events: [] });
  assert.equal(surface.displayModel().reason, 'none', 'no records is empty with reason none');
  assert.equal(surface.requestOpenAgent('ag-1'), 'not-ready');
  surface.loadSuccess({ agents: AGENTS, events: [] });
  assert.equal(surface.observe().regionState, 'ready', 'agents alone still carry supervision state');
  assert.ok(AGENT_RUNTIME_OPEN_RESULTS.includes('unknown-agent'));
  assert.ok(AGENT_RUNTIME_OPEN_RESULTS.includes('not-ready'));
  for (const action of AGENT_RUNTIME_ACTIONS) assert.ok(AGENT_RUNTIME_ACTIONS.includes(action));
});
