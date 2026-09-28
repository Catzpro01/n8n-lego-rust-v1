/**
 * P2-S12 - Auth surface pilot (issue #240).
 *
 * The strangler slice for the sign-in, user-management and membership
 * surfaces. Credential verification, session issuance and the /rest/login
 * exchange stay OUT of this slice - the surface never sees a credential.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: one hand-over payload, no login call,
 *         identity never re-derived, credentials/session material refused,
 *         closed REGION_STATES + role/facet vocabularies (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, assertive/busy exclusivity (D)
 *   CP-05 bounds + facet mutation + declared requests, owner rule, explicit
 *         failure and degradation (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAuthSurface,
  authSurfaceContract,
  authActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  AUTH_STATES,
  AUTH_FACETS,
  AUTH_DEFAULT_FACET,
  AUTH_GLOBAL_ROLES,
  AUTH_PROJECT_ROLES,
  AUTH_ASSIGNABLE_GLOBAL_ROLES,
  AUTH_ACTIONS,
  AUTH_ROLE_CHANGE_RESULTS,
  AUTH_SIGN_IN_RESULTS,
  AUTH_SIGN_OUT_RESULTS,
  AUTH_EMPTY_REASONS,
  AUTH_A11Y,
  AUTH_MAX_VISIBLE_HARD_MAX,
  AUTH_SURFACE_ID,
} from '../src/auth.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const IDENTITY = { userId: 'u-owner', role: 'global:owner' };
const ROW_OWNER = { id: 'u-owner', facet: 'users', label: 'owner@n8n.example', role: 'global:owner' };
const ROW_ADMIN = { id: 'u-admin', facet: 'users', label: 'admin@n8n.example', role: 'global:admin' };
const ROW_MEMBER = { id: 'u-member', facet: 'users', label: 'member@n8n.example', role: 'global:member' };
const ROW_PROJECT = { id: 'p-alpha', facet: 'membership', label: 'Alpha workspace', role: 'project:editor' };

function payload(entries = [ROW_OWNER, ROW_ADMIN, ROW_MEMBER, ROW_PROJECT], identity = IDENTITY) {
  return { identity, entries };
}

function loadedSurface(entries, identity) {
  const surface = createAuthSurface();
  surface.loadSuccess(payload(entries, identity));
  return surface;
}

/* ------------------------------------------------------------- A (CP-01) */

test('A identity and directory enter only through one hand-over payload: the surface issues no login call', () => {
  const surface = createAuthSurface();
  assert.equal(surface.contract.inputBoundary.source, 'hand-over');
  assert.equal(surface.contract.inputBoundary.entryPoint, 'loadSuccess');
  assert.equal(surface.contract.inputBoundary.issuesLoginCall, false);
  assert.equal(surface.contract.inputBoundary.reDerivesIdentity, false);
  assert.equal(surface.contract.inputBoundary.carriesSecrets, false);
  surface.loadSuccess(payload([ROW_OWNER]));
  assert.equal(surface.displayModel().total, 1);
  assert.deepEqual(surface.displayModel().identity, IDENTITY);
});

test('A credential and session material is refused with an explicit security error', () => {
  const surface = createAuthSurface();
  for (const key of ['password', 'passwordHash', 'token', 'refreshToken', 'sessionToken', 'sessionId', 'mfaCode', 'apiKey', 'credentials', 'cookie']) {
    assert.throws(
      () => surface.loadSuccess({ ...payload([ROW_ADMIN]), [key]: 'hunter2' }),
      (error) => {
        assert.match(error.message, /secret-bearing field/);
        assert.match(error.message, /never reach this surface/);
        return true;
      },
      `payload.${key}`,
    );
    assert.throws(
      () => surface.loadSuccess({ identity: { ...IDENTITY, [key]: 'hunter2' }, entries: [] }),
      /secret-bearing field/,
      `identity.${key}`,
    );
    assert.throws(
      () => surface.loadSuccess({ identity: null, entries: [{ ...ROW_ADMIN, [key]: 'hunter2' }] }),
      /secret-bearing field/,
      `entry.${key}`,
    );
  }
  assert.equal(surface.displayModel().total, 0, 'a refused load leaves the region untouched');
  assert.equal(surface.displayModel().identity, null, 'a refused load hands over nothing');
});

test('A the hand-over payload, identity and rows are closed shapes - refused, not dropped', () => {
  const surface = createAuthSurface();
  assert.throws(() => surface.loadSuccess([ROW_OWNER]), /payload object/);
  assert.throws(() => surface.loadSuccess({ entries: [] }), /must have exactly identity,entries/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: [], extra: 1 }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: 'no' }), /entries must be an array/);
  assert.throws(() => surface.loadSuccess({ identity: { userId: 'u' }, entries: [] }), /must have exactly userId,role/);
  assert.throws(() => surface.loadSuccess({ identity: { userId: ' ', role: 'global:member' }, entries: [] }), /non-empty/);
  assert.throws(() => surface.loadSuccess({ identity: { userId: 'u', role: 'superuser' }, entries: [] }), /identity field role must be one of/);
  assert.throws(() => surface.loadSuccess({ identity: 'u-owner', entries: [] }), /null or an object/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: [{ id: 'x', facet: 'users', label: 'x' }] }), /must have exactly/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: [{ ...ROW_ADMIN, role: 'root' }] }), /field role must be one of/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: [{ ...ROW_ADMIN, facet: 'signin' }] }), /must not be "signin"/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: [{ ...ROW_ADMIN, facet: 'billing' }] }), /field facet must be one of/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: [{ ...ROW_ADMIN, id: ' ' }] }), /non-empty/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: [{ ...ROW_PROJECT, role: 'global:admin' }] }), /field role must be one of/);
  assert.throws(() => surface.loadSuccess({ identity: null, entries: ['not-an-object'] }), /must be an object/);
});

test('A identity is handed over, never re-derived locally from the directory', () => {
  const anonymous = createAuthSurface();
  anonymous.loadSuccess(payload([ROW_OWNER, ROW_ADMIN], null));
  assert.equal(anonymous.displayModel().identity, null, 'rows never imply a session');
  const loaded = loadedSurface();
  assert.deepEqual(loaded.displayModel().identity, IDENTITY, 'identity is exactly what the payload carried');
  assert.equal(loaded.contract.inputBoundary.reDerivesIdentity, false);
});

test('A the contract states are pinned to REGION_STATES exactly - no fifth state', () => {
  const contract = authSurfaceContract();
  assert.deepEqual(AUTH_STATES, REGION_STATES);
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
});

test('A the facet, role, action and request-result vocabularies are closed', () => {
  const contract = authSurfaceContract();
  // The three screens this slice carries; the sign-in screen is a facet, not a row.
  assert.deepEqual([...AUTH_FACETS], ['signin', 'users', 'membership']);
  assert.equal(AUTH_DEFAULT_FACET, 'signin');
  // Reference n8n 2.9.4 system roles (user.schema ROLE / teamRoleSchema);
  // custom roles exist upstream and are refused here, fail-closed.
  assert.deepEqual([...AUTH_GLOBAL_ROLES], ['global:owner', 'global:admin', 'global:member', 'global:chatUser']);
  assert.deepEqual([...AUTH_PROJECT_ROLES], ['project:admin', 'project:editor', 'project:viewer', 'project:chatUser']);
  // Reference rule: the owner's global role cannot be changed.
  assert.deepEqual([...AUTH_ASSIGNABLE_GLOBAL_ROLES], ['global:admin', 'global:member', 'global:chatUser']);
  assert.equal(AUTH_ASSIGNABLE_GLOBAL_ROLES.includes('global:owner'), false);
  assert.deepEqual([...AUTH_ACTIONS], ['refresh', 'sign-in', 'sign-out', 'switch-facet', 'change-role']);
  assert.deepEqual([...AUTH_ROLE_CHANGE_RESULTS], ['accepted', 'not-ready', 'unknown-id', 'invalid-role', 'same-role', 'owner-unchangeable']);
  assert.deepEqual([...AUTH_SIGN_IN_RESULTS], ['accepted', 'already-signed-in', 'not-ready']);
  assert.deepEqual([...AUTH_SIGN_OUT_RESULTS], ['accepted', 'not-signed-in', 'not-ready']);
  assert.deepEqual([...AUTH_EMPTY_REASONS], ['none', 'filtered']);
  assert.deepEqual(contract.vocabularies.facets, AUTH_FACETS);
  assert.deepEqual(contract.vocabularies.globalRoles, AUTH_GLOBAL_ROLES);
  assert.deepEqual(contract.vocabularies.projectRoles, AUTH_PROJECT_ROLES);
  for (const region of REGION_STATES) {
    for (const action of authActionsFor(region)) {
      assert.ok(AUTH_ACTIONS.includes(action), `${action} in ${region} is declared`);
    }
  }
});

/* ------------------------------------------------------------- B (CP-02) */

test('B the surface migrates as a pilot with rollback pilot-not-primary', () => {
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === 'ui.auth.identity');
  assert.ok(entry, 'ui.auth.identity entry exists');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.match(entry.evidencePath, /49-auth\.test\.mjs/);
  assert.deepEqual(entry.surfaceIds, [AUTH_SURFACE_ID]);
  assert.equal(entry.slice, 'P2-S12');
  assert.equal(entry.sourceIssue, '240');
});

test('B the capability declares the pilot and degrades to native behavior', () => {
  const caps = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'capabilities.json'), 'utf8'));
  const list = caps.capabilities ?? caps;
  const cap = list.find((c) => c.id === AUTH_SURFACE_ID);
  assert.ok(cap, 'auth capability declared');
  assert.equal(cap.entry, './src/auth.mjs');
  assert.equal(cap.degradation.fallback, 'native-behavior');
  assert.ok(cap.tests.some((t) => /49-auth\.test\.mjs/.test(t)));
  assert.deepEqual(cap.surfaces, [AUTH_SURFACE_ID]);
});

/* ------------------------------------------------------------- C (CP-03) */

test('C loading is parity-equivalent to the reference', () => {
  const surface = createAuthSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C an empty directory is parity-equivalent for both empty reasons', () => {
  const none = createAuthSurface();
  none.loadSuccess(payload([], null));
  assert.equal(none.setFacet('users'), 'empty');
  assert.equal(none.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), none.observe()).status, PARITY_STATUSES[0]);

  const filtered = loadedSurface([ROW_OWNER, ROW_ADMIN], IDENTITY);
  assert.equal(filtered.setFacet('membership'), 'empty');
  assert.equal(filtered.displayModel().reason, 'filtered');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'filtered' }), filtered.observe()).status, PARITY_STATUSES[0]);
});

test('C a handed-over session and directory are parity-equivalent', () => {
  const surface = loadedSurface();
  assert.equal(compareObservations(referenceReadyObservation(), surface.observe()).status, PARITY_STATUSES[0]);
  surface.setFacet('users');
  assert.equal(compareObservations(referenceReadyObservation(), surface.observe()).status, PARITY_STATUSES[0]);
  surface.setFacet('signin');
  assert.equal(compareObservations(referenceReadyObservation(), surface.observe()).status, PARITY_STATUSES[0]);
});

test('C a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createAuthSurface();
  surface.loadFailure({ kind: 'auth' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'auth' }), surface.observe()).status, PARITY_STATUSES[0]);
});

test('C the harness is fail-closed: a drifted field is migration-required', () => {
  const surface = createAuthSurface();
  surface.loadSuccess(payload([], null));
  assert.equal(surface.setFacet('users'), 'empty');
  const { status } = compareObservations(referenceReadyObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[2]);
});

test('C an incomparable observation throws, never silently passes', () => {
  const surface = loadedSurface();
  assert.throws(
    () => compareObservations(referenceReadyObservation(), { ...surface.observe(), regionState: 'ghost' }),
    ParityError,
  );
});

/* ------------------------------------------------------------- D (CP-04) */

test('D the a11y intent is derived once from AUTH_A11Y', () => {
  const surface = loadedSurface();
  assert.equal(surface.a11y(), AUTH_A11Y.ready);
  assert.deepEqual(surface.observe().accessibility, AUTH_A11Y.ready);
});

test('D only error is assertive and only loading is busy', () => {
  for (const state of REGION_STATES) {
    const attrs = AUTH_A11Y[state];
    if (state === 'error') assert.equal(attrs.ariaLive, 'assertive');
    else assert.equal(attrs.ariaLive, 'polite');
    if (state === 'loading') assert.equal(attrs.ariaBusy, true);
    else assert.equal(attrs.ariaBusy, false);
    if (state === 'ready') assert.equal(attrs.role, 'region');
    else assert.equal(attrs.role, 'status');
  }
});

/* ------------------------------------------------------------- E (CP-05) */

test('E visible directory rows are bounded and truncation is observable', () => {
  const surface = createAuthSurface({ maxVisible: 2 });
  const rows = Array.from({ length: 5 }, (unused, i) => ({
    id: `u-${i}`, facet: 'users', label: `user-${i}@n8n.example`, role: 'global:member',
  }));
  surface.loadSuccess(payload(rows, null));
  surface.setFacet('users');
  const model = surface.displayModel();
  assert.equal(model.shown.length, 2);
  assert.equal(model.truncated, true);
  assert.equal(model.total, 5);
  const capped = createAuthSurface({ maxVisible: AUTH_MAX_VISIBLE_HARD_MAX + 10 });
  assert.equal(capped.maxVisible, AUTH_MAX_VISIBLE_HARD_MAX);
  assert.throws(() => createAuthSurface({ maxVisible: 0 }), /positive integer/);
});

test('E the facet switch is an observable mutation: sign-in, users, membership', () => {
  const surface = loadedSurface();
  assert.equal(surface.displayModel().facet, AUTH_DEFAULT_FACET);
  assert.equal(surface.setFacet('users'), 'ready');
  assert.equal(surface.displayModel().visibleCount, 3);
  assert.equal(surface.setFacet('membership'), 'ready');
  assert.equal(surface.displayModel().visibleCount, 1);
  surface.loadSuccess(payload([ROW_OWNER], IDENTITY));
  assert.equal(surface.displayModel().facet, AUTH_DEFAULT_FACET, 'loadSuccess resets to the sign-in facet');
  assert.equal(surface.setFacet('users'), 'ready');
  assert.equal(surface.setFacet('membership'), 'empty');
  assert.equal(surface.displayModel().reason, 'filtered');
  assert.equal(surface.setFacet('signin'), 'ready', 'the sign-in facet is ready once the hand-over landed');
  assert.throws(() => surface.setFacet('billing'), /facet must be one of/);
});

test('E declared requests are explicit: sign-in, sign-out and the owner rule', () => {
  const anonymous = loadedSurface([ROW_OWNER, ROW_ADMIN], null);
  assert.equal(anonymous.requestSignIn(), 'accepted');
  assert.equal(anonymous.requestSignOut(), 'not-signed-in');
  const signedIn = loadedSurface();
  assert.equal(signedIn.requestSignIn(), 'already-signed-in');
  assert.equal(signedIn.requestSignOut(), 'accepted');
  signedIn.setLoading();
  assert.equal(signedIn.requestSignIn(), 'not-ready');
  assert.equal(signedIn.requestSignOut(), 'not-ready');
  // Sign-in/sign-out never mutate identity or the directory - declared only.
  signedIn.setFacet('users');
  assert.deepEqual(signedIn.displayModel().identity, IDENTITY);
  assert.equal(signedIn.displayModel().total, 4);
});

test('E role changes are declared with the reference owner rule, never executed', () => {
  const surface = loadedSurface();
  surface.setFacet('users');
  assert.equal(surface.requestRoleChange(ROW_OWNER.id, 'global:member'), 'owner-unchangeable');
  assert.equal(surface.requestRoleChange(ROW_ADMIN.id, 'global:member'), 'accepted');
  assert.equal(surface.requestRoleChange(ROW_ADMIN.id, 'global:admin'), 'same-role');
  assert.equal(surface.requestRoleChange(ROW_ADMIN.id, 'global:owner'), 'invalid-role', 'owner is not assignable');
  assert.equal(surface.requestRoleChange(ROW_ADMIN.id, 'root'), 'invalid-role');
  assert.equal(surface.requestRoleChange(ROW_ADMIN.id, 'project:admin'), 'invalid-role', 'facets keep their role namespace');
  assert.equal(surface.requestRoleChange('ghost', 'global:member'), 'unknown-id');
  assert.throws(() => surface.requestRoleChange('', 'global:member'), /non-empty/);
  surface.setLoading();
  assert.equal(surface.requestRoleChange(ROW_ADMIN.id, 'global:member'), 'not-ready');
  // The declared request changed no directory data.
  surface.loadSuccess(payload(), IDENTITY);
  surface.setFacet('users');
  assert.equal(surface.displayModel().total, 4);
  assert.equal(surface.displayModel().shown.filter((row) => row.facet === 'membership').length, 0);
  assert.equal(surface.requestRoleChange(ROW_PROJECT.id, 'project:admin'), 'accepted');
  assert.equal(surface.requestRoleChange(ROW_PROJECT.id, 'project:editor'), 'same-role');
});

test('E failure is explicit: the error region carries a retry affordance', () => {
  const surface = createAuthSurface();
  assert.equal(surface.loadFailure({ kind: 'network' }), 'error');
  const model = surface.displayModel();
  assert.deepEqual([...model.actions], ['refresh']);
  assert.throws(() => surface.loadFailure(null), /error object/);
  const degraded = createAuthSurface({ renderAvailable: false });
  degraded.loadSuccess(payload([ROW_OWNER], IDENTITY));
  assert.ok(degraded.degradedEvents > 0);
});

test('E loadSuccess resets the facet and history is deterministic', () => {
  const surface = loadedSurface();
  surface.setFacet('users');
  surface.requestRoleChange(ROW_ADMIN.id, 'global:member');
  surface.loadSuccess(payload([ROW_OWNER], null));
  assert.equal(surface.displayModel().facet, AUTH_DEFAULT_FACET);
  assert.equal(surface.displayModel().identity, null);
  const again = loadedSurface([ROW_OWNER, ROW_ADMIN, ROW_MEMBER, ROW_PROJECT], IDENTITY);
  again.setFacet('membership');
  again.requestRoleChange(ROW_PROJECT.id, 'project:admin');
  assert.deepEqual(
    again.history.map((h) => h.name),
    ['loaded', 'switched-facet', 'role-change-requested'],
  );
});
