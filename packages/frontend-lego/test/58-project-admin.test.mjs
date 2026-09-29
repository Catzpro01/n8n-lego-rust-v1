/**
 * P2-S21 - Project/workspace administration surface pilot (issue #240).
 *
 * The strangler slice for the project and workspace administration panels
 * (beyond the settings shell) split out of P2-S03. Membership and project
 * data are handed over - the surface holds no project model of its own
 * until P5-M11 exists: no fetch, no mutation of a record, no direct call to
 * the project/role capability. Invite / remove / rename are DECLARED
 * interactions with explicit results, and the selected project is view
 * state cleared by every fresh hand-over.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over {projects, members}, no
 *         fetch, no workflow save, secret envelope refused, closed
 *         REGION_STATES + role/action/result vocabularies (A)
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
  createProjectAdminSurface,
  projectAdminSurfaceContract,
  projectAdminActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  PROJECT_ADMIN_STATES,
  PROJECT_ROLES,
  PROJECT_ADMIN_EMPTY_REASONS,
  PROJECT_ADMIN_ACTIONS,
  PROJECT_ADMIN_SELECT_RESULTS,
  PROJECT_ADMIN_INVITE_RESULTS,
  PROJECT_ADMIN_REMOVE_RESULTS,
  PROJECT_ADMIN_RENAME_RESULTS,
  PROJECT_ADMIN_LABELS,
  PROJECT_ADMIN_A11Y,
  PROJECT_ADMIN_MAX_VISIBLE_DEFAULT,
  PROJECT_ADMIN_MAX_VISIBLE_HARD_MAX,
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_ADMIN_SURFACE_ID,
} from '../src/project-admin.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const PROJECTS = [
  { id: 'pr-alpha', name: 'Finance ops', memberCount: 4 },
  { id: 'pr-beta', name: 'Growth squad', memberCount: 2 },
  { id: 'pr-gamma', name: 'Platform', memberCount: 6 },
];

const MEMBERS = [
  { userId: 'u-ann', displayName: 'Ann', role: 'owner' },
  { userId: 'u-ben', displayName: 'Ben', role: 'admin' },
  { userId: 'u-cid', displayName: 'Cid', role: 'member' },
];

function loadedSurface(projects = PROJECTS, members = MEMBERS, options = {}) {
  const surface = createProjectAdminSurface(options);
  surface.loadSuccess({ projects, members });
  return surface;
}

const projectsSnapshot = (surface) => JSON.stringify(
  surface.displayModel().shown.map(({ id, name, memberCount }) => ({ id, name, memberCount })),
);

const membersSnapshot = (surface) => JSON.stringify(
  surface.members.map(({ userId, displayName, role }) => ({ userId, displayName, role })),
);

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary with no fetch and no save', () => {
  const contract = projectAdminSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesEngineCall: false,
    issuesWorkflowSave: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, PROJECT_ADMIN_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.roles, PROJECT_ROLES);
  assert.deepEqual(contract.vocabularies.actions, PROJECT_ADMIN_ACTIONS);
  assert.deepEqual(contract.vocabularies.selectResults, PROJECT_ADMIN_SELECT_RESULTS);
  assert.deepEqual(contract.vocabularies.inviteResults, PROJECT_ADMIN_INVITE_RESULTS);
  assert.deepEqual(contract.vocabularies.removeResults, PROJECT_ADMIN_REMOVE_RESULTS);
  assert.deepEqual(contract.vocabularies.renameResults, PROJECT_ADMIN_RENAME_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, PROJECT_ADMIN_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, PROJECT_ADMIN_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, PROJECT_ADMIN_MAX_VISIBLE_HARD_MAX);
  assert.equal(contract.bounds.nameMaxLength, PROJECT_NAME_MAX_LENGTH);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(PROJECT_ADMIN_STATES, REGION_STATES);
  assert.deepEqual(PROJECT_ADMIN_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(PROJECT_ROLES, ['owner', 'admin', 'member']);
  for (const vocab of [PROJECT_ROLES, PROJECT_ADMIN_ACTIONS, PROJECT_ADMIN_SELECT_RESULTS, PROJECT_ADMIN_INVITE_RESULTS, PROJECT_ADMIN_REMOVE_RESULTS, PROJECT_ADMIN_RENAME_RESULTS, PROJECT_ADMIN_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the envelope carries no secrets', () => {
  const surface = createProjectAdminSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({}), /must have exactly projects,members/);
  assert.throws(() => surface.loadSuccess({ projects: [], members: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ projects: 'no', members: [] }), /projects \(array\)/);
  assert.throws(() => surface.loadSuccess({ projects: [], members: 'no' }), /members \(array\)/);
  assert.throws(
    () => surface.loadSuccess({ projects: [{ id: 'p', name: 'N', memberCount: 0, token: 'x' }], members: [] }),
    /secret-bearing field token/,
  );
  assert.throws(
    () => surface.loadSuccess({ projects: [], members: [], sessionId: 'x' }),
    /secret-bearing field sessionId/,
  );
});

test('A records are a closed shape and the hand-over is consistent', () => {
  const surface = createProjectAdminSurface();
  assert.throws(() => surface.loadSuccess({ projects: ['p'], members: [] }), /project 0 must be an object/);
  assert.throws(
    () => surface.loadSuccess({ projects: [{ id: 'p', name: 'N', memberCount: 0, extra: 1 }], members: [] }),
    /must have exactly id, name, memberCount|must have exactly id,name,memberCount/,
  );
  assert.throws(
    () => surface.loadSuccess({ projects: [{ id: 'p', name: 'N', memberCount: -1 }], members: [] }),
    /memberCount must be a non-negative integer/,
  );
  assert.throws(
    () => surface.loadSuccess({ projects: [{ id: 'p', name: 'N', memberCount: 0 }, { id: 'p', name: 'N2', memberCount: 1 }], members: [] }),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess({ projects: [], members: [{ userId: 'u', displayName: 'U', role: 'superuser' }] }),
    /field role must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess({ projects: [], members: [{ userId: 'u', displayName: 'U', role: 'owner' }, { userId: 'u', displayName: 'U2', role: 'member' }] }),
    /repeats the userId/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch, no evaluator, no capability call', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'project-admin.mjs'));
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
  const execAssigns = code.match(/projects = Object\.freeze\(payload\.projects/g) ?? [];
  assert.equal(execAssigns.length, 1, 'the handed-over projects are installed in loadSuccess exactly once');
  const fieldWrites = code.match(/\.(name|memberCount|role|displayName)\s*=(?!=)\s*/g) ?? [];
  assert.equal(fieldWrites.length, 0, 'no record field is ever written locally - only a fresh hand-over changes records');
});

test('A the declared actions never mutate a record - the owning capability owns every outcome', () => {
  const surface = loadedSurface();
  const pBefore = projectsSnapshot(surface);
  const mBefore = membersSnapshot(surface);
  assert.equal(surface.selectProject('pr-alpha'), 'accepted');
  assert.equal(surface.requestInvite('u-cid', 'member'), 'accepted');
  assert.equal(surface.requestRemoveMember('u-ben'), 'accepted');
  assert.equal(surface.requestRename('Finance ops 2.0'), 'accepted');
  assert.equal(projectsSnapshot(surface), pBefore, 'id/name/memberCount are byte-identical after every declared action');
  assert.equal(membersSnapshot(surface), mBefore, 'userId/displayName/role are byte-identical after every declared action');
  assert.deepEqual(surface.selection, 'pr-alpha', 'only the view selection moved');
  assert.ok(PROJECT_ADMIN_INVITE_RESULTS.includes('accepted'));
  assert.ok(PROJECT_ADMIN_REMOVE_RESULTS.includes('invalid-role'));
  assert.ok(PROJECT_ADMIN_RENAME_RESULTS.includes('invalid-name'));
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.settings.projects-admin');
  assert.ok(entry, 'ui.settings.projects-admin is registered');
  assert.deepEqual(entry.surfaceIds, ['project-admin']);
  assert.equal(entry.category, 'projects-workspace');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S21');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/58-project-admin.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the project-admin capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'project-admin');
  assert.ok(capability, 'project-admin capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/project-admin.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'project-admin');
  assert.deepEqual(capability.surfaces, ['project-admin']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n'), 'fallback keeps the reference editor');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/58-project-admin.test.mjs']);
  assert.equal(capability.phase, 'P2-S21');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createProjectAdminSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createProjectAdminSurface();
  empty.loadSuccess({ projects: [], members: [] });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createProjectAdminSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, requestRename: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  assert.throws(() => compareObservations({}, {}), ParityError);
  assert.throws(() => referenceEmptyObservation({ reason: 'filtered' }), /reason must be one of/);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: form landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(PROJECT_ADMIN_A11Y.ready, { role: 'form', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(PROJECT_ADMIN_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(PROJECT_ADMIN_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(PROJECT_ADMIN_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), PROJECT_ADMIN_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createProjectAdminSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), PROJECT_ADMIN_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  let model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    ['project:pr-alpha', 'project:pr-beta', 'project:pr-gamma'],
    'project rows in hand-over order; member controls appear only with a selection',
  );
  assert.equal(surface.selectProject('pr-alpha'), 'accepted');
  model = surface.displayModel();
  assert.deepEqual(
    model.focusOrder,
    [
      'project:pr-alpha', 'project:pr-beta', 'project:pr-gamma',
      'member:u-ann', 'member:u-ben', 'member:u-cid',
      'invite', 'rename',
    ],
    'the member rows and controls become reachable once a project is selected, rows never reorder',
  );
  assert.equal(surface.selectProject('pr-alpha'), 'accepted', 're-selecting clears');
  assert.deepEqual(surface.displayModel().focusOrder, ['project:pr-alpha', 'project:pr-beta', 'project:pr-gamma'], 'clearing drops the member controls');
  for (const key of ['select', 'invite', 'remove', 'rename', 'refresh']) {
    assert.equal(typeof PROJECT_ADMIN_LABELS[key], 'string');
    assert.ok(PROJECT_ADMIN_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, PROJECT_ADMIN_LABELS, 'labels are declared once');
  assert.equal(model.announcement, 'pr-alpha', 'the selection announces the project id');
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(projectAdminActionsFor('loading'), []);
  assert.deepEqual(projectAdminActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(projectAdminActionsFor('empty'), ['refresh']);
  assert.deepEqual(projectAdminActionsFor('ready'), ['refresh', 'select-project', 'request-invite', 'request-remove-member', 'request-rename']);

  const loading = createProjectAdminSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const empty = createProjectAdminSurface();
  empty.loadSuccess({ projects: [], members: [] });
  assert.deepEqual(empty.displayModel().actions, ['refresh'], 'a projectless workspace offers only refresh');
  const failed = createProjectAdminSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded project list: default cap, hard clamp and truncation reported', () => {
  const projects = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, memberCount: i }));
  const surface = loadedSurface(projects, MEMBERS);
  assert.equal(surface.maxVisible, PROJECT_ADMIN_MAX_VISIBLE_DEFAULT);
  const model = surface.displayModel();
  assert.equal(model.shown.length, PROJECT_ADMIN_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 60);

  const wide = createProjectAdminSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, PROJECT_ADMIN_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createProjectAdminSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createProjectAdminSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const projects = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, memberCount: i % 7 }));
  const members = Array.from({ length: 50 }, (_, i) => ({ userId: `u${i}`, displayName: `User ${i}`, role: PROJECT_ROLES[i % 3] }));
  const surface = createProjectAdminSurface({ maxVisible: PROJECT_ADMIN_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ projects, members });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `200 projects x20 renders took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createProjectAdminSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  surface.setLoading();
  surface.loadSuccess({ projects: PROJECTS, members: MEMBERS });
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface(PROJECTS, MEMBERS, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.selectProject('pr-alpha');
  assert.equal(surface.degradedEvents, 2, 'the selection counted');
  surface.requestInvite('u-cid', 'member');
  assert.equal(surface.degradedEvents, 3, 'the invite counted');
  surface.requestRename('Renamed');
  assert.equal(surface.degradedEvents, 4, 'the rename counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createProjectAdminSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and never mutate the hand-over', () => {
  const surface = loadedSurface();
  const pBefore = projectsSnapshot(surface);
  const mBefore = membersSnapshot(surface);
  // select-project: view state only, toggle, unknown refused
  assert.equal(surface.selectProject('pr-ghost'), 'unknown-project');
  assert.equal(surface.selectProject('pr-alpha'), 'accepted');
  assert.equal(surface.selectProject('pr-alpha'), 'accepted', 're-selecting clears it again');
  assert.equal(surface.selection, null, 'the toggle cleared it');
  assert.throws(() => surface.selectProject(' '), /non-empty project id/);
  // invite: gated on the selection
  assert.equal(surface.requestInvite('u-cid', 'member'), 'unknown-project', 'no selection means no project');
  surface.selectProject('pr-beta');
  assert.equal(surface.requestInvite('u-cid', 'member'), 'accepted');
  assert.throws(() => surface.requestInvite(' ', 'member'), /non-empty userId/);
  assert.throws(() => surface.requestInvite('u-cid', 'superuser'), /expects a role/);
  // remove: closed results, the owner can never be removed
  assert.equal(surface.requestRemoveMember('u-ghost'), 'unknown-member');
  assert.equal(surface.requestRemoveMember('u-ann'), 'invalid-role', 'the owner is protected');
  assert.equal(surface.requestRemoveMember('u-ben'), 'accepted');
  assert.throws(() => surface.requestRemoveMember(' '), /non-empty userId/);
  // rename: closed name rule
  assert.equal(surface.requestRename(''), 'invalid-name', 'empty is refused');
  assert.equal(surface.requestRename('x'.repeat(PROJECT_NAME_MAX_LENGTH + 1)), 'invalid-name', 'over the bound is refused');
  assert.equal(surface.requestRename('Growth squad v2'), 'accepted');
  assert.throws(() => surface.requestRename(42), /expects a name string/);
  // not-ready everywhere beyond refresh
  surface.setLoading();
  assert.equal(surface.selectProject('pr-alpha'), 'not-ready');
  assert.equal(surface.requestInvite('u-cid', 'member'), 'not-ready');
  assert.equal(surface.requestRemoveMember('u-ben'), 'not-ready');
  assert.equal(surface.requestRename('x'), 'not-ready');
  // fresh hand-over clears the selection; records stay byte-identical
  surface.loadSuccess({ projects: PROJECTS, members: MEMBERS });
  assert.equal(surface.selection, null, 'a fresh hand-over clears the selection');
  assert.equal(surface.requestInvite('u-cid', 'member'), 'unknown-project');
  assert.equal(projectsSnapshot(surface), pBefore, 'project records are byte-identical after every declared request');
  assert.equal(membersSnapshot(surface), mBefore, 'member records are byte-identical after every declared request');
  // empty region refuses everything beyond refresh
  surface.loadSuccess({ projects: [], members: [] });
  assert.equal(surface.displayModel().reason, 'none', 'no projects is empty with reason none');
  assert.equal(surface.selectProject('pr-alpha'), 'not-ready');
  assert.ok(PROJECT_ADMIN_SELECT_RESULTS.includes('unknown-project'));
  assert.ok(PROJECT_ADMIN_INVITE_RESULTS.includes('not-ready'));
  assert.ok(PROJECT_ADMIN_REMOVE_RESULTS.includes('invalid-role'));
  assert.ok(PROJECT_ADMIN_RENAME_RESULTS.includes('invalid-name'));
  for (const action of PROJECT_ADMIN_ACTIONS) assert.ok(PROJECT_ADMIN_ACTIONS.includes(action));
});
