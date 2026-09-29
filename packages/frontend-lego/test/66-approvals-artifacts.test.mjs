/**
 * P2-S29 - Approvals and artifacts surface pilot (issue #240, Layer 5).
 *
 * The strangler slice for the approval queue and artifact review surfaces
 * split out of P2-S03 (final P2 slice). The review state is handed over
 * through the approval capability - the surface is READ-ONLY AND NEVER
 * WRITES A DECISION: no fetch, no store access, no mutation of a record.
 * request-approve / request-reject are declared, routed through the
 * declared action path, and only a pending approval is actionable; the
 * outcome arrives via a fresh hand-over. Vocabularies are quoted:
 * decisionApprovalState, artifactKind and artifactRetention from
 * vocabulary.mjs - no local vocabulary.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {approvals, artifacts},
 *         read-only, declared decision path, no fetch, no workflow save,
 *         secret envelope refused, closed REGION_STATES + status/kind/
 *         retention/action/result vocabularies (A)
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
  createApprovalsArtifactsSurface,
  approvalsArtifactsSurfaceContract,
  approvalsArtifactsActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  APPROVALS_ARTIFACTS_STATES,
  APPROVAL_STATES,
  ARTIFACT_KINDS,
  ARTIFACT_RETENTIONS,
  APPROVALS_ARTIFACTS_EMPTY_REASONS,
  APPROVALS_ARTIFACTS_ACTIONS,
  APPROVALS_ARTIFACTS_DECISION_RESULTS,
  APPROVALS_ARTIFACTS_LABELS,
  APPROVALS_ARTIFACTS_A11Y,
  APPROVALS_ARTIFACTS_MAX_VISIBLE_DEFAULT,
  APPROVALS_ARTIFACTS_MAX_VISIBLE_HARD_MAX,
  APPROVAL_NAME_MAX_LENGTH,
  APPROVALS_ARTIFACTS_SURFACE_ID,
} from '../src/approvals-artifacts.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const APPROVALS = [
  { approvalId: 'ap-1', artifactId: 'ar-1', status: 'pending' },
  { approvalId: 'ap-2', artifactId: 'ar-2', status: 'granted' },
  { approvalId: 'ap-3', artifactId: 'ar-3', status: 'denied' },
  { approvalId: 'ap-4', artifactId: 'ar-4', status: 'not-required' },
];
const ARTIFACTS = [
  { artifactId: 'ar-1', name: 'invoice-reconcile.patch', kind: 'patch', retention: 'retained' },
  { artifactId: 'ar-2', name: 'run-summary.report', kind: 'report', retention: 'session' },
  { artifactId: 'ar-3', name: 'trace.log', kind: 'log', retention: 'ephemeral' },
];

function loadedSurface(approvals = APPROVALS, artifacts = ARTIFACTS, options = {}) {
  const surface = createApprovalsArtifactsSurface(options);
  surface.loadSuccess({ approvals, artifacts });
  return surface;
}

const approvalSnapshot = (surface) => JSON.stringify(
  surface.approvals.map(({ approvalId, artifactId, status }) => ({ approvalId, artifactId, status })),
);
const artifactSnapshot = (surface) => JSON.stringify(
  surface.artifacts.map(({ artifactId, name, kind, retention }) => ({ artifactId, name, kind, retention })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = approvalsArtifactsSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, APPROVALS_ARTIFACTS_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.approvalStates, APPROVAL_STATES);
  assert.deepEqual(contract.vocabularies.artifactKinds, ARTIFACT_KINDS);
  assert.deepEqual(contract.vocabularies.artifactRetentions, ARTIFACT_RETENTIONS);
  assert.deepEqual(contract.vocabularies.actions, APPROVALS_ARTIFACTS_ACTIONS);
  assert.deepEqual(contract.vocabularies.decisionResults, APPROVALS_ARTIFACTS_DECISION_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, APPROVALS_ARTIFACTS_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, APPROVALS_ARTIFACTS_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, APPROVALS_ARTIFACTS_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.nameMaxLength, APPROVAL_NAME_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES and the vocabularies are quoted', () => {
  assert.deepEqual(APPROVALS_ARTIFACTS_STATES, REGION_STATES);
  assert.deepEqual(APPROVALS_ARTIFACTS_STATES, ['loading', 'empty', 'error', 'ready']);
  // QUOTED, never redefined: the surface has no vocabulary of its own.
  assert.deepEqual(APPROVAL_STATES, ['not-required', 'pending', 'granted', 'denied']);
  assert.equal(ARTIFACT_KINDS.length, 8, 'the 8 locked artifact kinds, verbatim');
  assert.ok(ARTIFACT_KINDS.includes('patch') && ARTIFACT_KINDS.includes('model-output'));
  assert.deepEqual(ARTIFACT_RETENTIONS, ['ephemeral', 'session', 'retained', 'pinned']);
  for (const vocab of [APPROVAL_STATES, ARTIFACT_KINDS, ARTIFACT_RETENTIONS, APPROVALS_ARTIFACTS_ACTIONS, APPROVALS_ARTIFACTS_DECISION_RESULTS, APPROVALS_ARTIFACTS_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createApprovalsArtifactsSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly approvals,artifacts/);
  assert.throws(() => surface.loadSuccess({ approvals: [], artifacts: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ approvals: 'no', artifacts: [] }), /approvals \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ approvals: [{ approvalId: 'ap', artifactId: 'ar', status: 'pending', token: 'y' }], artifacts: [] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ approvals: [], artifacts: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createApprovalsArtifactsSurface();
  const base = { approvals: [], artifacts: [] };
  assert.throws(() => surface.loadSuccess({ ...base, approvals: ['a'] }), /approval 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ ...base, approvals: [{ approvalId: 'ap', artifactId: 'ar', status: 'pending', extra: 1 }] }),
    /must have exactly approvalId,artifactId,status/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, approvals: [{ approvalId: 'ap', artifactId: 'ar', status: 'ghost' }] }),
    /field status must be one of not-required, pending, granted, denied/,
  );
  assert.throws(
    () => surface.loadSuccess({ ...base, approvals: [{ approvalId: 'ap', artifactId: 'ar', status: 'pending' }, { approvalId: 'ap', artifactId: 'ar', status: 'pending' }] }),
    /repeats the approvalId/,
  );
  assert.throws(
    () => surface.loadSuccess({ approvals: [], artifacts: [{ artifactId: 'ar', name: 'x', kind: 'ghost', retention: 'retained' }] }),
    /field kind must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess({ approvals: [], artifacts: [{ artifactId: 'ar', name: 'x', kind: 'log', retention: 'forever' }] }),
    /field retention must be one of ephemeral, session, retained, pinned/,
  );
  assert.throws(
    () => surface.loadSuccess({ approvals: [], artifacts: [{ artifactId: 'ar', name: 'x'.repeat(APPROVAL_NAME_MAX_LENGTH + 1), kind: 'log', retention: 'session' }] }),
    /field name must be at most/,
  );
  assert.throws(
    () => surface.loadSuccess({ approvals: [], artifacts: [{ artifactId: 'ar', name: 'a', kind: 'log', retention: 'session' }, { artifactId: 'ar', name: 'b', kind: 'log', retention: 'session' }] }),
    /repeats the artifactId/,
  );
});

test('A decisions are never written locally: loadSuccess is the only entry, no fetch, no evaluator, no writes', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'approvals-artifacts.mjs'));
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
  const installs = code.match(/approvals = Object\.freeze\(payload\.approvals/g) ?? [];
  assert.equal(installs.length, 1, 'the approvals are installed in loadSuccess exactly once');
  const fieldWrites = code.match(/\.(approvalId|artifactId|status|name|retention)\s*=(?!=)/g) ?? [];
  assert.equal(fieldWrites.length, 0, 'no record field is ever written locally - the surface is read-only');
  const persist = code.match(/\b(localStorage|sessionStorage|writeFile|saveDecision|persist)\b/g) ?? [];
  assert.equal(persist.length, 0, 'a decision is never persisted anywhere');
});

test('A declared decisions never mutate the records - the outcome arrives via fresh hand-over', () => {
  const surface = loadedSurface();
  const approvalBefore = approvalSnapshot(surface);
  const artifactBefore = artifactSnapshot(surface);
  assert.equal(surface.requestApprove('ap-1'), 'accepted', 'pending is actionable');
  assert.equal(surface.requestReject('ap-1'), 'accepted');
  assert.equal(surface.requestApprove('ap-2'), 'invalid-state', 'granted is not actionable');
  assert.equal(surface.requestReject('ap-3'), 'invalid-state', 'denied is not actionable');
  assert.equal(surface.requestApprove('ap-ghost'), 'unknown-approval');
  assert.equal(approvalSnapshot(surface), approvalBefore, 'approvalId/artifactId/status are byte-identical after every declared request');
  assert.equal(artifactSnapshot(surface), artifactBefore, 'the artifact index is byte-identical after every declared request');
  surface.loadSuccess({ approvals: APPROVALS, artifacts: ARTIFACTS });
  assert.equal(approvalSnapshot(surface), approvalBefore, 'a fresh hand-over yields the same read-only records');
  assert.ok(APPROVALS_ARTIFACTS_DECISION_RESULTS.includes('accepted'));
  assert.ok(APPROVALS_ARTIFACTS_DECISION_RESULTS.includes('invalid-state'));
  assert.ok(APPROVALS_ARTIFACTS_DECISION_RESULTS.includes('unknown-approval'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.approvals.artifacts');
  assert.ok(entry, 'ui.approvals.artifacts is registered');
  assert.deepEqual(entry.surfaceIds, ['approvals-artifacts']);
  assert.equal(entry.category, 'approvals-artifacts');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S29');
  assert.deepEqual(entry.dependencies, []);
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/66-approvals-artifacts.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the approvals-artifacts capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'approvals-artifacts');
  assert.ok(capability, 'approvals-artifacts capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/approvals-artifacts.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'approvals-artifacts');
  assert.deepEqual(capability.surfaces, ['approvals-artifacts']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/66-approvals-artifacts.test.mjs']);
  assert.equal(capability.phase, 'P2-S29');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createApprovalsArtifactsSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createApprovalsArtifactsSurface();
  empty.loadSuccess({ approvals: [], artifacts: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createApprovalsArtifactsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestApprove: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(APPROVALS_ARTIFACTS_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(APPROVALS_ARTIFACTS_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(APPROVALS_ARTIFACTS_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(APPROVALS_ARTIFACTS_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), APPROVALS_ARTIFACTS_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createApprovalsArtifactsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), APPROVALS_ARTIFACTS_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  const model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['view:approvals', 'view:artifacts', 'approval:ap-1', 'approval:ap-2', 'approval:ap-3', 'approval:ap-4', 'artifact:ar-1', 'artifact:ar-2', 'artifact:ar-3'],
    'the two views lead, then approvals then artifacts in hand-over order, rows never reorder',
  );
  for (const key of ['approve', 'reject', 'refresh', 'approvals', 'artifacts']) {
    assert.equal(typeof APPROVALS_ARTIFACTS_LABELS[key], 'string');
    assert.ok(APPROVALS_ARTIFACTS_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, APPROVALS_ARTIFACTS_LABELS, 'labels are declared once');
  surface.requestApprove('ap-1');
  assert.equal(surface.displayModel().announcement, 'approve:ap-1', 'the request announces the approval id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(approvalsArtifactsActionsFor('loading'), []);
  assert.deepEqual(approvalsArtifactsActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(approvalsArtifactsActionsFor('empty'), ['refresh']);
  assert.deepEqual(approvalsArtifactsActionsFor('ready'), ['refresh', 'request-approve', 'request-reject']);

  const loading = createApprovalsArtifactsSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createApprovalsArtifactsSurface();
  empty.loadSuccess({ approvals: [], artifacts: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'an empty queue offers only refresh');
  const failed = createApprovalsArtifactsSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded approval window: default cap, hard clamp and truncation reported', () => {
  const approvals = Array.from({ length: 45 }, (_, i) => ({
    approvalId: `ap${i}`,
    artifactId: `ar${i}`,
    status: APPROVAL_STATES[i % 4],
  }));
  const surface = loadedSurface(approvals, ARTIFACTS);
  assert.equal(surface.maxVisible, APPROVALS_ARTIFACTS_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, APPROVALS_ARTIFACTS_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 45);
  assert.equal(model.shown[0].approvalId, 'ap15', 'the window keeps the newest approval rows');
  assert.equal(model.artifactCount, ARTIFACTS.length, 'the artifact index is shown in full');

  const wide = createApprovalsArtifactsSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, APPROVALS_ARTIFACTS_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createApprovalsArtifactsSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createApprovalsArtifactsSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const approvals = Array.from({ length: 200 }, (_, i) => ({
    approvalId: `ap${i}`,
    artifactId: `ar${i}`,
    status: APPROVAL_STATES[i % 4],
  }));
  const surface = createApprovalsArtifactsSurface({ maxVisible: APPROVALS_ARTIFACTS_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ approvals, artifacts: ARTIFACTS });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 approvals x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createApprovalsArtifactsSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ approvals: APPROVALS, artifacts: ARTIFACTS });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(APPROVALS, ARTIFACTS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.requestApprove('ap-1');
  assert.equal(surface.degradedEvents, 2, 'the decision request counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createApprovalsArtifactsSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared decisions answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const before = approvalSnapshot(surface);
  // request-approve/request-reject: closed vocabulary
  assert.equal(surface.requestApprove('ap-ghost'), 'unknown-approval');
  assert.equal(surface.requestApprove('ap-1'), 'accepted');
  assert.equal(surface.requestReject('ap-4'), 'invalid-state', 'not-required is not actionable');
  assert.throws(() => surface.requestApprove(' '), /non-empty approval id/);
  assert.throws(() => surface.requestReject(' '), /non-empty approval id/);
  // not-ready beyond refresh
  surface.setLoading();
  assert.equal(surface.requestApprove('ap-1'), 'not-ready');
  // fresh hand-over: read-only, byte-identical
  surface.loadSuccess({ approvals: APPROVALS, artifacts: ARTIFACTS });
  assert.equal(approvalSnapshot(surface), before, 'approvalId/artifactId/status are byte-identical after every declared request');
  // empty region refuses everything beyond refresh; artifacts alone still ready
  surface.loadSuccess({ approvals: [], artifacts: [] });
  assert.equal(surface.displayModel().reason, 'none', 'no records is empty with reason none');
  assert.equal(surface.requestReject('ap-1'), 'not-ready');
  surface.loadSuccess({ approvals: [], artifacts: ARTIFACTS });
  assert.equal(surface.observe().regionState, 'ready', 'artifacts alone still carry review state');
  for (const r of ['accepted', 'unknown-approval', 'invalid-state', 'not-ready']) {
    assert.ok(APPROVALS_ARTIFACTS_DECISION_RESULTS.includes(r));
  }
  for (const action of APPROVALS_ARTIFACTS_ACTIONS) assert.ok(APPROVALS_ARTIFACTS_ACTIONS.includes(action));
});
