/**
 * P2-S09 - Credentials list pilot (issue #240).
 *
 * The strangler slice for the credentials list surface (credential list,
 * create/delete and sharing affordances). The value-entry editor, the P5/P2.27
 * credential envelope and the credential runtime stay OUT of this slice.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: hand-over only, values refused at the
 *         boundary, closed REGION_STATES, no credential-data mutation (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, assertive/busy exclusivity (D)
 *   CP-05 bounds + visibility mutation + explicit requests and failure (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createCredentialsSurface,
  credentialsSurfaceContract,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  CREDENTIALS_STATES,
  CREDENTIALS_ACTIONS,
  CREDENTIALS_VISIBILITY,
  CREDENTIALS_REQUEST_RESULTS,
  CREDENTIALS_A11Y,
  CREDENTIALS_MAX_VISIBLE_HARD_MAX,
  CREDENTIALS_SURFACE_ID,
} from '../src/credentials.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ROW_A = { id: 'cr-1', name: 'Prod Slack', type: 'slackApi', createdAt: '2026-09-01T00:00:00Z', shared: true };
const ROW_B = { id: 'cr-2', name: 'Local HTTP', type: 'httpBasicAuth', createdAt: '2026-09-02T00:00:00Z', shared: false };

function readySurface() {
  const surface = createCredentialsSurface();
  surface.loadSuccess([ROW_A, ROW_B]);
  return surface;
}

/* ------------------------------------------------------------- A (CP-01) */

test('A rows enter only through loadSuccess: the surface holds no credential data path', () => {
  const surface = createCredentialsSurface();
  assert.equal(surface.contract.inputBoundary.source, 'hand-over');
  assert.equal(surface.contract.inputBoundary.entryPoint, 'loadSuccess');
  assert.equal(surface.contract.inputBoundary.mutatesCredentialData, false);
  assert.equal(surface.contract.inputBoundary.carriesValues, false);
  surface.loadSuccess([ROW_A]);
  assert.equal(surface.displayModel().total, 1);
});

test('A a row carrying a value-bearing field is refused with an explicit security error', () => {
  const surface = createCredentialsSurface();
  assert.throws(
    () => surface.loadSuccess([{ ...ROW_A, value: 'shh' }]),
    /value-bearing field value: credential values never reach this surface/,
  );
  assert.throws(
    () => surface.loadSuccess([{ ...ROW_A, oauthToken: 'tok' }]),
    /value-bearing field oauthToken: credential values never reach this surface/,
  );
  assert.throws(
    () => surface.loadSuccess([{ ...ROW_A, data: '{}' }]),
    /value-bearing field data: credential values never reach this surface/,
  );
});

test('A a row outside the closed shape is refused, not dropped', () => {
  const surface = createCredentialsSurface();
  assert.throws(() => surface.loadSuccess([{ id: 'x', name: 'X' }]), /must have exactly/);
  assert.throws(() => surface.loadSuccess([{ ...ROW_A, extra: 1 }]), /must have exactly/);
  assert.throws(() => surface.loadSuccess([{ ...ROW_A, shared: 'yes' }]), /shared must be a boolean/);
  assert.throws(() => surface.loadSuccess(['not-an-object']), /must be an object/);
});

test('A the contract states are pinned to REGION_STATES exactly - no fifth state', () => {
  const contract = credentialsSurfaceContract();
  assert.deepEqual(Object.keys(contract.states), [...REGION_STATES]);
  assert.deepEqual([...CREDENTIALS_STATES], [...REGION_STATES]);
  const surface = readySurface();
  surface.setVisibility('shared');
  surface.setVisibility('private');
  // filtering to zero is empty with reason filtered - never a fifth region state
  surface.loadSuccess([ROW_A]); // only shared rows
  surface.setVisibility('private');
  assert.equal(surface.observe().regionState, 'empty');
  assert.equal(surface.displayModel().reason, 'filtered');
  assert.deepEqual(Object.keys(surface.contract.states), [...REGION_STATES]);
});

test('A the action, visibility and request-result vocabularies are closed', () => {
  const contract = credentialsSurfaceContract();
  assert.deepEqual([...contract.vocabularies.actions], [...CREDENTIALS_ACTIONS]);
  assert.deepEqual([...contract.vocabularies.visibility], [...CREDENTIALS_VISIBILITY]);
  assert.deepEqual([...contract.vocabularies.requestResults], [...CREDENTIALS_REQUEST_RESULTS]);
  assert.deepEqual([...contract.vocabularies.emptyReasons], ['none', 'filtered']);
});

/* ------------------------------------------------------------- B (CP-02) */

test('B the surface migrates as a pilot with rollback pilot-not-primary', () => {
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === 'ui.credentials.list');
  assert.ok(entry, 'ui.credentials.list entry exists');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.match(entry.evidencePath, /46-credentials\.test\.mjs/);
  assert.deepEqual(entry.surfaceIds, [CREDENTIALS_SURFACE_ID]);
  assert.equal(entry.slice, 'P2-S09');
  // The P5 credential security boundary stays finding-only (never modified here).
  assert.match(entry.notes, /P5/);
});

test('B the capability declares the pilot and degrades to native behavior', () => {
  const caps = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'capabilities.json'), 'utf8'));
  const list = caps.capabilities ?? caps;
  const cap = list.find((c) => c.id === CREDENTIALS_SURFACE_ID);
  assert.ok(cap, 'credentials capability declared');
  assert.equal(cap.entry, './src/credentials.mjs');
  assert.equal(cap.degradation.fallback, 'native-behavior');
  assert.ok(cap.tests.some((t) => /46-credentials\.test\.mjs/.test(t)));
  assert.deepEqual(cap.surfaces, [CREDENTIALS_SURFACE_ID]);
});

/* ------------------------------------------------------------- C (CP-03) */

test('C loading is parity-equivalent to the reference', () => {
  const surface = createCredentialsSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C an empty list (no credentials) is parity-equivalent', () => {
  const surface = createCredentialsSurface();
  surface.loadSuccess([]);
  const { status } = compareObservations(referenceEmptyObservation({ reason: 'none' }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C a loaded list is parity-equivalent', () => {
  const surface = readySurface();
  const { status } = compareObservations(referenceReadyObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createCredentialsSurface();
  surface.loadFailure({ kind: 'timeout' });
  const { status } = compareObservations(referenceErrorObservation({ errorKind: 'timeout' }), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C the harness is fail-closed: a drifted field is migration-required', () => {
  const surface = createCredentialsSurface();
  surface.loadSuccess([]);
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

test('D the a11y intent is derived once from CREDENTIALS_A11Y', () => {
  const surface = readySurface();
  assert.equal(surface.a11y(), CREDENTIALS_A11Y.ready);
  assert.deepEqual(surface.observe().accessibility, CREDENTIALS_A11Y.ready);
});

test('D only error is assertive and only loading is busy', () => {
  for (const state of REGION_STATES) {
    const attrs = CREDENTIALS_A11Y[state];
    if (state === 'error') assert.equal(attrs.ariaLive, 'assertive');
    else assert.equal(attrs.ariaLive, 'polite');
    if (state === 'loading') assert.equal(attrs.ariaBusy, true);
    else assert.equal(attrs.ariaBusy, false);
  }
});

/* ------------------------------------------------------------- E (CP-05) */

test('E visible rows are bounded and truncation is observable', () => {
  const surface = createCredentialsSurface({ maxVisible: 2 });
  const rows = Array.from({ length: 5 }, (unused, i) => ({
    id: `cr-${i}`, name: `Cred ${i}`, type: 'httpBasicAuth', createdAt: '2026-09-01T00:00:00Z', shared: false,
  }));
  surface.loadSuccess(rows);
  const model = surface.displayModel();
  assert.equal(model.shown.length, 2);
  assert.equal(model.truncated, true);
  assert.equal(model.total, 5);
  const capped = createCredentialsSurface({ maxVisible: CREDENTIALS_MAX_VISIBLE_HARD_MAX + 10 });
  assert.equal(capped.maxVisible, CREDENTIALS_MAX_VISIBLE_HARD_MAX);
  assert.throws(() => createCredentialsSurface({ maxVisible: 0 }), /positive integer/);
});

test('E the visibility filter is an observable mutation: narrow, clear', () => {
  const surface = readySurface();
  assert.equal(surface.setVisibility('shared'), 'ready');
  assert.equal(surface.displayModel().visibleCount, 1);
  assert.equal(surface.setVisibility('private'), 'ready');
  assert.equal(surface.displayModel().visibleCount, 1);
  surface.loadSuccess([ROW_A]);
  assert.equal(surface.setVisibility('private'), 'empty');
  assert.equal(surface.displayModel().reason, 'filtered');
  assert.equal(surface.setVisibility('all'), 'ready');
  assert.throws(() => surface.setVisibility('everything'), /visibility must be one of/);
});

test('E requests are declared and explicit, and credential data never changes', () => {
  const surface = readySurface();
  assert.equal(surface.requestCreate(), 'requested');
  assert.equal(surface.requestDelete(ROW_A.id), 'requested');
  assert.equal(surface.requestShare(ROW_B.id), 'requested');
  assert.equal(surface.requestDelete('ghost'), 'unknown-id');
  assert.equal(surface.requestShare('ghost'), 'unknown-id');
  surface.setLoading();
  assert.equal(surface.requestCreate(), 'not-ready');
  assert.equal(surface.requestDelete(ROW_A.id), 'not-ready');
  assert.throws(() => surface.requestDelete(''), /non-empty/);
  assert.throws(() => surface.requestShare(''), /non-empty/);
});

test('E failure is explicit: the error region carries a retry affordance', () => {
  const surface = createCredentialsSurface();
  assert.equal(surface.loadFailure({ kind: 'network' }), 'error');
  const model = surface.displayModel();
  assert.deepEqual([...model.actions], ['refresh']);
  assert.throws(() => surface.loadFailure(null), /error object/);
  const degraded = createCredentialsSurface({ renderAvailable: false });
  degraded.loadSuccess([ROW_A, ROW_B]);
  assert.ok(degraded.degradedEvents > 0);
});

test('E loadSuccess resets the filter and history is deterministic', () => {
  const surface = readySurface();
  surface.setVisibility('shared');
  surface.loadSuccess([ROW_A, ROW_B]);
  assert.equal(surface.displayModel().visibility, 'all');
  const again = createCredentialsSurface();
  again.loadSuccess([ROW_A, ROW_B]);
  again.setVisibility('shared');
  again.requestDelete(ROW_A.id);
  assert.deepEqual(again.history.map((h) => h.name), ['loaded', 'filtered', 'delete-requested']);
});
