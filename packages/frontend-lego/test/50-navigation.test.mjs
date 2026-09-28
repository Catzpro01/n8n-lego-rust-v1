/**
 * P2-S13 - Navigation surface pilot (issue #240).
 *
 * The strangler slice for the primary navigation, breadcrumbs and
 * route-switching shell split out of P2-S03. The route table and the active
 * route are handed over - the surface never fetches, never reads location and
 * issues no route change; the app-layer router owns history.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: handed-over route table, no route
 *         change call, no routing authority, secret paths refused, closed
 *         REGION_STATES + region/kind vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, keyboard reachability + focus order,
 *         shared loading/empty/error interaction primitives (D)
 *   CP-05 bounds, measured render cost, explicit failure/degradation,
 *         filter-to-zero semantics, declared requests (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createNavigationSurface,
  navigationSurfaceContract,
  navActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  NAV_STATES,
  NAV_REGIONS,
  NAV_ROUTE_KINDS,
  NAV_EMPTY_REASONS,
  NAV_ACTIONS,
  NAV_ROUTE_RESULTS,
  NAV_BACK_RESULTS,
  NAV_LABELS,
  NAV_A11Y,
  NAV_MAX_VISIBLE_DEFAULT,
  NAV_MAX_VISIBLE_HARD_MAX,
  NAV_SURFACE_ID,
} from '../src/navigation.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');

const ROOT = { id: 'root', path: '/', label: 'n8n', kind: 'root', parent: null };
const WORKFLOWS = { id: 'workflows', path: '/workflows', label: 'Workflows', kind: 'page', parent: null };
const EXECUTIONS = { id: 'executions', path: '/executions', label: 'Executions', kind: 'page', parent: null };
const CREDENTIALS = { id: 'credentials', path: '/credentials', label: 'Credentials', kind: 'page', parent: null };
const SETTINGS = { id: 'settings', path: '/settings', label: 'Settings', kind: 'section', parent: null };
const SETTINGS_USERS = { id: 'settings-users', path: '/settings/users', label: 'Users', kind: 'page', parent: 'settings' };
const SETTINGS_API = { id: 'settings-api', path: '/settings/api', label: 'API', kind: 'page', parent: 'settings' };
const VARIABLES = { id: 'variables', path: '/variables', label: 'Variables', kind: 'page', parent: null };

const ROUTES = [ROOT, WORKFLOWS, EXECUTIONS, CREDENTIALS, SETTINGS, SETTINGS_USERS, SETTINGS_API, VARIABLES];

function payload(routes = ROUTES, active = 'workflows') {
  return { routes, active };
}

function loadedSurface(routes = ROUTES, active = 'workflows', options = {}) {
  const surface = createNavigationSurface(options);
  surface.loadSuccess(payload(routes, active));
  return surface;
}

/* ------------------------------------------------ A (CP-01) boundary + contract */

test('A the contract declares the hand-over boundary and no routing authority', () => {
  const contract = navigationSurfaceContract();
  assert.deepEqual(contract.inputBoundary, {
    source: 'hand-over',
    entryPoint: 'loadSuccess',
    issuesRouteChange: false,
    ownsRoutingAuthority: false,
    carriesSecrets: false,
  });
  assert.equal(contract.id, NAV_SURFACE_ID);
  assert.equal(contract.version, 'p1');
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
  for (const state of REGION_STATES) {
    assert.deepEqual(contract.states[state], { state });
  }
  assert.deepEqual(contract.vocabularies.regions, NAV_REGIONS);
  assert.deepEqual(contract.vocabularies.routeKinds, NAV_ROUTE_KINDS);
  assert.deepEqual(contract.vocabularies.actions, NAV_ACTIONS);
  assert.deepEqual(contract.vocabularies.routeResults, NAV_ROUTE_RESULTS);
  assert.deepEqual(contract.vocabularies.backResults, NAV_BACK_RESULTS);
  assert.deepEqual(contract.vocabularies.emptyReasons, NAV_EMPTY_REASONS);
  assert.equal(contract.bounds.maxVisibleDefault, NAV_MAX_VISIBLE_DEFAULT);
  assert.equal(contract.bounds.maxVisibleHardMax, NAV_MAX_VISIBLE_HARD_MAX);
});

test('A the four region states are exactly the shared REGION_STATES', () => {
  assert.deepEqual(NAV_STATES, REGION_STATES);
  assert.deepEqual(NAV_STATES, ['loading', 'empty', 'error', 'ready']);
  assert.deepEqual(NAV_REGIONS, ['sidebar', 'topbar', 'breadcrumbs']);
  assert.deepEqual(NAV_ROUTE_KINDS, ['root', 'section', 'page']);
  assert.deepEqual(NAV_EMPTY_REASONS, ['none', 'filtered']);
  for (const vocab of [NAV_REGIONS, NAV_ROUTE_KINDS, NAV_ACTIONS, NAV_ROUTE_RESULTS, NAV_BACK_RESULTS, NAV_EMPTY_REASONS]) {
    assert.ok(Object.isFrozen(vocab), 'closed vocabularies are frozen');
  }
});

test('A the payload is one closed hand-over and the table carries no secrets', () => {
  const surface = createNavigationSurface();
  assert.throws(() => surface.loadSuccess(null), /payload object/);
  assert.throws(() => surface.loadSuccess({ routes: [] }), /must have exactly routes,active/);
  assert.throws(() => surface.loadSuccess({ routes: [], active: null, extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ routes: 'no', active: null }), /must be an array/);
  assert.throws(() => surface.loadSuccess({ routes: [], active: 'workflows' }), /active null/);
  assert.throws(() => surface.loadSuccess(payload(ROUTES, 'ghost')), /must name a handed-over route/);
  // secret-bearing keys are refused fail-closed - never dropped
  assert.throws(() => surface.loadSuccess({ routes: [], active: null, token: 'x' }), /secret-bearing field token/);
  const withSecretKey = [{ id: 'x', path: '/x', label: 'x', kind: 'page', parent: null, password: 'x' }];
  assert.throws(() => surface.loadSuccess({ routes: withSecretKey, active: 'x' }), /secret-bearing field password/);
  // a path carrying secret query material is refused, never sanitized
  const withSecretPath = [{ id: 'x', path: '/cb?token=abc', label: 'x', kind: 'page', parent: null }];
  assert.throws(() => surface.loadSuccess({ routes: withSecretPath, active: 'x' }), /secret query material/);
});

test('A route entries are a closed shape: exact keys, reference kinds, known parents, unique ids', () => {
  const surface = createNavigationSurface();
  assert.throws(() => surface.loadSuccess(payload(['not-an-object'])), /must be an object/);
  assert.throws(
    () => surface.loadSuccess(payload([{ id: 'x', path: '/x', label: 'x', kind: 'page' }])),
    /must have exactly id,path,label,kind,parent/,
  );
  assert.throws(
    () => surface.loadSuccess(payload([{ ...WORKFLOWS, extra: 1 }])),
    /must have exactly/,
  );
  assert.throws(
    () => surface.loadSuccess(payload([{ ...WORKFLOWS, path: 'workflows' }])),
    /must start with "\/"/,
  );
  assert.throws(
    () => surface.loadSuccess(payload([{ ...WORKFLOWS, kind: 'folder' }])),
    /field kind must be one of/,
  );
  assert.throws(
    () => surface.loadSuccess(payload([{ ...SETTINGS_USERS, parent: 'ghost' }])),
    /unknown route "ghost"/,
  );
  assert.throws(
    () => surface.loadSuccess(payload([WORKFLOWS, { ...WORKFLOWS }])),
    /repeats the id/,
  );
  assert.throws(
    () => surface.loadSuccess(payload([{ ...WORKFLOWS, label: ' ' }])),
    /non-empty string/,
  );
});

test('A the surface holds no private data path: loadSuccess is the only entry, no fetch/location/pushState', () => {
  const source = read(join(PACKAGE_ROOT, 'src', 'navigation.mjs'));
  // strip comments first: the prose is allowed to describe what it forbids
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('fetch('), false, 'the surface never fetches');
  assert.equal(code.includes('window.'), false, 'the surface never reads window');
  assert.equal(code.includes('location'), false, 'the surface never reads location');
  assert.equal(code.includes('pushState'), false, 'the surface never touches history entries');
  assert.equal(code.includes('XMLHttpRequest'), false, 'no XHR');
  const assigns = code.match(/routes = Object\.freeze\(payload\.routes/g) ?? [];
  assert.equal(assigns.length, 1, 'the handed-over table is installed in loadSuccess exactly once');
  const activeAssigns = code.match(/active = payload\.active/g) ?? [];
  assert.equal(activeAssigns.length, 1, 'the active route comes from the hand-over exactly once');
});

test('A an accepted route request never changes the active route here (no authority)', () => {
  const surface = loadedSurface();
  assert.equal(surface.requestOpenRoute('executions'), 'accepted');
  assert.equal(surface.displayModel().active, 'workflows', 'active is still what was handed over');
  assert.equal(surface.displayModel().announcement, 'Executions', 'the pending announcement is declared');
  const last = surface.history.at(-1);
  assert.equal(last.name, 'route-change-requested');
});

/* ------------------------------------------------------ B (CP-02) pilot pins */

test('B the surface-migrations manifest pins the pilot and its rollback path', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json')));
  const entry = manifest.entries.find((row) => row.inventoryId === 'ui.shell.navigation');
  assert.ok(entry, 'ui.shell.navigation is registered');
  assert.deepEqual(entry.surfaceIds, ['navigation']);
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.equal(entry.referenceImplementation, 'n8n-editor-ui@2.9.4');
  assert.equal(entry.proposedLegoOwner, 'ui-frontend');
  assert.equal(entry.sourceIssue, '240');
  assert.equal(entry.slice, 'P2-S13');
  assert.equal(entry.evidencePath, 'packages/frontend-lego/test/50-navigation.test.mjs');
  const repoRoot = join(PACKAGE_ROOT, '..', '..');
  assert.equal(read(join(repoRoot, entry.evidencePath)).length > 0, true, 'evidence path exists');
});

test('B the capability manifest declares the navigation capability with a native fallback', () => {
  const manifest = JSON.parse(read(join(PACKAGE_ROOT, 'manifest', 'capabilities.json')));
  const capability = manifest.capabilities.find((row) => row.id === 'navigation');
  assert.ok(capability, 'navigation capability is declared');
  assert.equal(capability.lego, 'ui-frontend');
  assert.equal(capability.entry, './src/navigation.mjs');
  assert.equal(capability.status, 'available');
  assert.equal(capability.lifecycle, 'available');
  assert.equal(capability.activation, 'lazy');
  assert.equal(capability.messages, 'navigation');
  assert.deepEqual(capability.surfaces, ['navigation']);
  assert.equal(capability.degradation.fallback, 'native-behavior');
  assert.ok(capability.degradation.detail.includes('reference n8n navigation'), 'fallback keeps the reference shell');
  assert.deepEqual(capability.tests, ['packages/frontend-lego/test/50-navigation.test.mjs']);
  assert.equal(capability.phase, 'P2-S13');
});

/* -------------------------------------------- C (CP-03) parity vs reference */

test('C every declared region state is parity-equivalent to the reference', () => {
  const loading = createNavigationSurface();
  assert.equal(compareObservations(referenceLoadingObservation(), loading.observe()).status, PARITY_STATUSES[0]);

  const empty = createNavigationSurface();
  empty.loadSuccess({ routes: [], active: null });
  assert.equal(empty.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), empty.observe()).status, PARITY_STATUSES[0]);

  const filtered = loadedSurface();
  assert.equal(filtered.setFilter('nothing-matches-this'), 'empty');
  assert.equal(filtered.displayModel().reason, 'filtered');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'filtered' }), filtered.observe()).status, PARITY_STATUSES[0]);

  const ready = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), ready.observe()).status, PARITY_STATUSES[0]);

  const failed = createNavigationSurface();
  failed.loadFailure({ kind: 'network' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'network' }), failed.observe()).status, PARITY_STATUSES[0]);
});

test('C a divergence from the reference is fail-closed, never hidden', () => {
  const surface = loadedSurface();
  const tampered = { ...surface.observe(), interactions: { ...surface.observe().interactions, openRoute: false } };
  const { status, diffs } = compareObservations(referenceReadyObservation(), tampered);
  assert.ok(PARITY_STATUSES.includes(status), 'status stays in the closed vocabulary');
  assert.notEqual(status, PARITY_STATUSES[0], 'a divergence never reports equivalent');
  assert.ok(diffs.length > 0, 'the divergence is recorded as evidence, not hidden');
  // invalid observations throw - there is no soft pass
  assert.throws(() => compareObservations({}, {}), ParityError);
});

/* ---------------------------------- D (CP-04) accessibility + interaction */

test('D the a11y intent is derived once: landmark on ready, assertive only on error, busy only on loading', () => {
  assert.deepEqual(NAV_A11Y.ready, { role: 'navigation', ariaLive: 'polite', ariaBusy: false });
  assert.deepEqual(NAV_A11Y.error, { role: 'status', ariaLive: 'assertive', ariaBusy: false });
  assert.deepEqual(NAV_A11Y.loading, { role: 'status', ariaLive: 'polite', ariaBusy: true });
  assert.deepEqual(NAV_A11Y.empty, { role: 'status', ariaLive: 'polite', ariaBusy: false });
  const surface = loadedSurface();
  assert.deepEqual(surface.a11y(), NAV_A11Y.ready, 'the view-model reports the derived intent, never a copy');
  const failed = createNavigationSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.a11y(), NAV_A11Y.error);
});

test('D keyboard reachability: focus order is stable, complete and labelled', () => {
  const surface = loadedSurface();
  const model = surface.displayModel();
  assert.equal(model.focusOrder[0], 'sidebar-toggle', 'the sidebar toggle is first');
  assert.deepEqual(
    model.focusOrder.filter((item) => item.startsWith('route:')),
    model.shown.map((route) => `route:${route.id}`),
    'every visible route is reachable in table order',
  );
  assert.deepEqual(
    model.focusOrder.filter((item) => item.startsWith('crumb:')),
    ['crumb:workflows'],
    'the active page carries its own breadcrumb',
  );
  assert.equal(model.focusOrder.at(-1), 'back', 'back comes last');
  for (const key of ['sidebarToggle', 'route', 'breadcrumb', 'back', 'filter']) {
    assert.equal(typeof NAV_LABELS[key], 'string');
    assert.ok(NAV_LABELS[key].trim().length > 0, `aria label for ${key}`);
  }
  assert.equal(model.labels, NAV_LABELS, 'labels are declared once');
  // a root route has no back affordance
  const atRoot = loadedSurface(ROUTES, 'root');
  assert.equal(atRoot.displayModel().focusOrder.includes('back'), false);
  // a section page walks its parent chain into the breadcrumbs
  const nested = loadedSurface(ROUTES, 'settings-users');
  assert.deepEqual(
    nested.displayModel().breadcrumbs.map((crumb) => crumb.id),
    ['settings', 'settings-users'],
  );
});

test('D the shared per-state interaction primitives hold for every state', () => {
  assert.deepEqual(navActionsFor('loading'), []);
  assert.deepEqual(navActionsFor('error'), ['refresh'], 'error offers exactly the retry affordance');
  assert.deepEqual(navActionsFor('empty'), ['refresh', 'toggle-sidebar']);
  assert.deepEqual(navActionsFor('ready'), ['refresh', 'open-route', 'toggle-sidebar', 'go-back']);

  const loading = createNavigationSurface();
  assert.deepEqual(loading.displayModel().actions, []);
  assert.equal(loading.displayModel().visible, true, 'loading is never a blank');
  const failed = createNavigationSurface();
  failed.loadFailure({ kind: 'network' });
  assert.deepEqual(failed.displayModel().actions, ['refresh']);
  assert.equal(failed.displayModel().error.kind, 'network', 'the error region carries the kind');
});

/* ------------------ E (CP-05) bounds, render cost, failure/degradation */

test('E bounded visible list: default cap, hard clamp and truncation reported', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `r${i}`, path: `/r${i}`, label: `Route ${i}`, kind: 'page', parent: null,
  }));
  const surface = loadedSurface(many, 'r0');
  assert.equal(surface.maxVisible, NAV_MAX_VISIBLE_DEFAULT);
  let model = surface.displayModel();
  assert.equal(model.shown.length, NAV_MAX_VISIBLE_DEFAULT);
  assert.equal(model.truncated, true, 'truncation is reported, never silent');
  assert.equal(model.visibleCount, 40);

  const wide = createNavigationSurface({ maxVisible: 9999 });
  assert.equal(wide.maxVisible, NAV_MAX_VISIBLE_HARD_MAX, 'the hard maximum clamps the request');
  assert.throws(() => createNavigationSurface({ maxVisible: 0 }), /positive integer/);
  assert.throws(() => createNavigationSurface({ maxVisible: 2.5 }), /positive integer/);
});

test('E a typical payload renders inside the measured budget', () => {
  const routes = Array.from({ length: 300 }, (_, i) => ({
    id: `r${i}`, path: `/section-${i % 20}/r${i}`, label: `Route number ${i}`, kind: 'page', parent: null,
  }));
  const surface = createNavigationSurface({ maxVisible: NAV_MAX_VISIBLE_HARD_MAX });
  const started = process.hrtime.bigint();
  surface.loadSuccess({ routes, active: 'r0' });
  for (let i = 0; i < 20; i += 1) surface.displayModel();
  surface.setFilter('route number 29');
  surface.displayModel();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 250, `300 routes x20 renders + filter took ${elapsedMs.toFixed(1)}ms (< 250ms)`);
});

test('E failure is an explicit error region with retry, never a silent blank', () => {
  const surface = createNavigationSurface();
  surface.loadFailure({ kind: 'network' });
  const model = surface.displayModel();
  assert.equal(model.visible, true, 'the region stays visible');
  assert.deepEqual(model.error, { kind: 'network' });
  assert.deepEqual(model.actions, ['refresh'], 'the retry affordance is the one offered action');
  assert.equal(surface.observe().regionState, 'error');
  // recovery path: loading -> fresh hand-over
  surface.setLoading();
  surface.loadSuccess(payload());
  assert.equal(surface.observe().regionState, 'ready');
  assert.equal(surface.displayModel().error, null);
});

test('E degraded mode counts every undeliverable interaction instead of failing silently', () => {
  const surface = loadedSurface([], null, { renderAvailable: false });
  assert.equal(surface.degradedEvents, 1, 'the load counted');
  surface.toggleSidebar();
  assert.equal(surface.degradedEvents, 2, 'the toggle counted');
  surface.setFilter('x');
  assert.equal(surface.degradedEvents, 3, 'the filter counted');
  const healthy = loadedSurface();
  assert.equal(healthy.degradedEvents, 0, 'no degradation when rendering is available');
  const failed = createNavigationSurface({ renderAvailable: false });
  failed.loadFailure({ kind: 'network' });
  assert.equal(failed.degradedEvents, 2, 'failure pushes the event and counts the lost render');
});

test('E declared requests answer the closed vocabularies and filter-to-zero is empty, not a fifth state', () => {
  const surface = loadedSurface();
  assert.equal(surface.requestOpenRoute('ghost'), 'unknown-route');
  assert.equal(surface.requestOpenRoute('workflows'), 'same-route');
  assert.equal(surface.requestOpenRoute('executions'), 'accepted');
  assert.equal(surface.requestGoBack(), 'accepted');
  surface.setLoading();
  assert.equal(surface.requestOpenRoute('executions'), 'not-ready');
  assert.equal(surface.requestGoBack(), 'not-ready');
  surface.loadSuccess(payload());
  assert.equal(surface.displayModel().announcement, null, 'the hand-over clears the pending announcement');
  assert.ok(NAV_ROUTE_RESULTS.includes('accepted'));
  assert.ok(NAV_BACK_RESULTS.includes('not-ready'));
  // filter to zero is empty with reason filtered; the table itself is none
  assert.equal(surface.setFilter('no-such-route'), 'empty');
  assert.equal(surface.displayModel().reason, 'filtered');
  const emptyTable = createNavigationSurface();
  emptyTable.loadSuccess({ routes: [], active: null });
  assert.equal(emptyTable.displayModel().reason, 'none');
  assert.equal(emptyTable.setFilter('anything'), 'empty');
  // the closed shape refuses an unknown action vocabulary drift
  const model = surface.displayModel();
  for (const action of model.actions) assert.ok(NAV_ACTIONS.includes(action));
});
