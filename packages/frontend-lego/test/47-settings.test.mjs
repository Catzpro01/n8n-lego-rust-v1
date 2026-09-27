/**
 * P2-S10 - Settings panels pilot (issue #240).
 *
 * The strangler slice for the settings surface (instance + personal settings
 * panels). Secret-valued settings and the settings write runtime stay OUT of
 * this slice.
 *
 * Evidence map:
 *   CP-01 boundary + closed contract: hand-over only, secret material refused
 *         at the boundary, closed REGION_STATES, no settings-data mutation (A)
 *   CP-02 pilot mode + rollback: manifest pins (B)
 *   CP-03 parity against the reference, fail-closed (C)
 *   CP-04 accessibility derived once, assertive/busy exclusivity (D)
 *   CP-05 bounds + panel mutation + explicit requests and failure (E)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSettingsSurface,
  settingsSurfaceContract,
  settingsActionsFor,
  referenceLoadingObservation,
  referenceEmptyObservation,
  referenceReadyObservation,
  referenceErrorObservation,
  SETTINGS_STATES,
  SETTINGS_PANELS,
  SETTINGS_DEFAULT_PANEL,
  SETTINGS_ACTIONS,
  SETTINGS_REQUEST_RESULTS,
  SETTINGS_EMPTY_REASONS,
  SETTINGS_A11Y,
  SETTINGS_MAX_VISIBLE_HARD_MAX,
  SETTINGS_SURFACE_ID,
} from '../src/settings.mjs';
import { REGION_STATES } from '../src/surface-contract.mjs';
import { compareObservations, PARITY_STATUSES, ParityError } from '../src/parity.mjs';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ENTRY_A = { id: 'instance.name', panel: 'instance', section: 'general', value: 'n8n' };
const ENTRY_B = { id: 'instance.timezone', panel: 'instance', section: 'locale', value: 'Europe/Berlin' };
const ENTRY_P = { id: 'personal.firstName', panel: 'personal', section: 'profile', value: 'Ada' };

function readySurface() {
  const surface = createSettingsSurface();
  surface.loadSuccess([ENTRY_A, ENTRY_B, ENTRY_P]);
  return surface;
}

/* ------------------------------------------------------------- A (CP-01) */

test('A entries enter only through loadSuccess: the surface holds no settings data path', () => {
  const surface = createSettingsSurface();
  assert.equal(surface.contract.inputBoundary.source, 'hand-over');
  assert.equal(surface.contract.inputBoundary.entryPoint, 'loadSuccess');
  assert.equal(surface.contract.inputBoundary.mutatesSettingsData, false);
  assert.equal(surface.contract.inputBoundary.carriesSecrets, false);
  surface.loadSuccess([ENTRY_A]);
  assert.equal(surface.displayModel().total, 1);
});

test('A an entry carrying a secret-bearing field is refused with an explicit security error', () => {
  const surface = createSettingsSurface();
  for (const key of ['password', 'token', 'apiKey', 'secret', 'smtpPass', 'privateKey']) {
    assert.throws(
      () => surface.loadSuccess([{ ...ENTRY_A, [key]: 'hunter2' }]),
      (error) => {
        assert.match(error.message, /secret-bearing field/);
        assert.match(error.message, /never reaches this surface/);
        return true;
      },
      key,
    );
  }
  assert.equal(surface.displayModel().visible, true, 'a refused load leaves the region untouched');
  assert.equal(surface.displayModel().total, 0);
});

test('A a non-scalar value is refused (a structured value could smuggle secret material)', () => {
  const surface = createSettingsSurface();
  for (const value of [{ nested: 'x' }, ['x'], null]) {
    assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, value }]), /must be a scalar/);
  }
});

test('A an entry outside the closed shape is refused, not dropped', () => {
  const surface = createSettingsSurface();
  assert.throws(() => surface.loadSuccess([{ id: 'x', panel: 'instance', section: 's' }]), /must have exactly/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, extra: 1 }]), /must have exactly/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, panel: 'cloud' }]), /panel must be one of/);
  assert.throws(() => surface.loadSuccess([{ ...ENTRY_A, id: ' ' }]), /non-empty string/);
  assert.throws(() => surface.loadSuccess(['not-an-object']), /must be an object/);
});

test('A the contract states are pinned to REGION_STATES exactly - no fifth state', () => {
  const contract = settingsSurfaceContract();
  assert.deepEqual(SETTINGS_STATES, REGION_STATES);
  assert.deepEqual(Object.keys(contract.states).sort(), [...REGION_STATES].sort());
});

test('A the panel, action, request-result and empty-reason vocabularies are closed', () => {
  const contract = settingsSurfaceContract();
  assert.deepEqual([...SETTINGS_PANELS], ['instance', 'personal']);
  assert.equal(SETTINGS_DEFAULT_PANEL, 'instance');
  assert.deepEqual([...SETTINGS_ACTIONS], ['refresh', 'save', 'reset', 'switch-panel']);
  assert.deepEqual([...SETTINGS_REQUEST_RESULTS], ['requested', 'unknown-id', 'not-ready']);
  assert.deepEqual([...SETTINGS_EMPTY_REASONS], ['none', 'filtered']);
  assert.deepEqual(contract.vocabularies.panels, SETTINGS_PANELS);
  for (const region of REGION_STATES) {
    for (const action of settingsActionsFor(region)) {
      assert.ok(SETTINGS_ACTIONS.includes(action), `${action} in ${region} is declared`);
    }
  }
});

/* ------------------------------------------------------------- B (CP-02) */

test('B the surface migrates as a pilot with rollback pilot-not-primary', () => {
  const inv = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'surface-migrations.json'), 'utf8'));
  const entry = inv.entries.find((e) => e.inventoryId === 'ui.settings.pages');
  assert.ok(entry, 'ui.settings.pages entry exists');
  assert.equal(entry.migrationStatus, 'pilot-available');
  assert.equal(entry.contractStatus, 'consuming');
  assert.equal(entry.rollbackStrategy, 'pilot-not-primary');
  assert.match(entry.evidencePath, /47-settings\.test\.mjs/);
  assert.deepEqual(entry.surfaceIds, [SETTINGS_SURFACE_ID]);
  assert.equal(entry.slice, 'P2-S10');
  assert.equal(entry.sourceIssue, '240');
});

test('B the capability declares the pilot and degrades to native behavior', () => {
  const caps = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'manifest', 'capabilities.json'), 'utf8'));
  const list = caps.capabilities ?? caps;
  const cap = list.find((c) => c.id === SETTINGS_SURFACE_ID);
  assert.ok(cap, 'settings capability declared');
  assert.equal(cap.entry, './src/settings.mjs');
  assert.equal(cap.degradation.fallback, 'native-behavior');
  assert.ok(cap.tests.some((t) => /47-settings\.test\.mjs/.test(t)));
  assert.deepEqual(cap.surfaces, [SETTINGS_SURFACE_ID]);
});

/* ------------------------------------------------------------- C (CP-03) */

test('C loading is parity-equivalent to the reference', () => {
  const surface = createSettingsSurface();
  const { status } = compareObservations(referenceLoadingObservation(), surface.observe());
  assert.equal(status, PARITY_STATUSES[0]);
});

test('C an empty panel is parity-equivalent for both empty reasons', () => {
  const none = createSettingsSurface();
  none.loadSuccess([]);
  assert.equal(none.displayModel().reason, 'none');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'none' }), none.observe()).status, PARITY_STATUSES[0]);

  const filtered = createSettingsSurface();
  filtered.loadSuccess([ENTRY_A, ENTRY_B]);
  filtered.setPanel('personal');
  assert.equal(filtered.displayModel().reason, 'filtered');
  assert.equal(compareObservations(referenceEmptyObservation({ reason: 'filtered' }), filtered.observe()).status, PARITY_STATUSES[0]);
});

test('C loaded panels are parity-equivalent', () => {
  const surface = readySurface();
  assert.equal(compareObservations(referenceReadyObservation(), surface.observe()).status, PARITY_STATUSES[0]);
  surface.setPanel('personal');
  assert.equal(compareObservations(referenceReadyObservation(), surface.observe()).status, PARITY_STATUSES[0]);
});

test('C a failed load is parity-equivalent for its declared error kind', () => {
  const surface = createSettingsSurface();
  surface.loadFailure({ kind: 'timeout' });
  assert.equal(compareObservations(referenceErrorObservation({ errorKind: 'timeout' }), surface.observe()).status, PARITY_STATUSES[0]);
});

test('C the harness is fail-closed: a drifted field is migration-required', () => {
  const surface = createSettingsSurface();
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

test('D the a11y intent is derived once from SETTINGS_A11Y', () => {
  const surface = readySurface();
  assert.equal(surface.a11y(), SETTINGS_A11Y.ready);
  assert.deepEqual(surface.observe().accessibility, SETTINGS_A11Y.ready);
});

test('D only error is assertive and only loading is busy', () => {
  for (const state of REGION_STATES) {
    const attrs = SETTINGS_A11Y[state];
    if (state === 'error') assert.equal(attrs.ariaLive, 'assertive');
    else assert.equal(attrs.ariaLive, 'polite');
    if (state === 'loading') assert.equal(attrs.ariaBusy, true);
    else assert.equal(attrs.ariaBusy, false);
  }
});

/* ------------------------------------------------------------- E (CP-05) */

test('E visible entries are bounded and truncation is observable', () => {
  const surface = createSettingsSurface({ maxVisible: 2 });
  const rows = Array.from({ length: 5 }, (unused, i) => ({
    id: `instance.k${i}`, panel: 'instance', section: 'general', value: i,
  }));
  surface.loadSuccess(rows);
  const model = surface.displayModel();
  assert.equal(model.shown.length, 2);
  assert.equal(model.truncated, true);
  assert.equal(model.total, 5);
  const capped = createSettingsSurface({ maxVisible: SETTINGS_MAX_VISIBLE_HARD_MAX + 10 });
  assert.equal(capped.maxVisible, SETTINGS_MAX_VISIBLE_HARD_MAX);
  assert.throws(() => createSettingsSurface({ maxVisible: 0 }), /positive integer/);
});

test('E the panel switch is an observable mutation: narrow, back', () => {
  const surface = readySurface();
  assert.equal(surface.setPanel('personal'), 'ready');
  assert.equal(surface.displayModel().visibleCount, 1);
  assert.equal(surface.displayModel().panel, 'personal');
  surface.loadSuccess([ENTRY_A, ENTRY_B]);
  assert.equal(surface.setPanel('personal'), 'empty');
  assert.equal(surface.displayModel().reason, 'filtered');
  assert.equal(surface.setPanel('instance'), 'ready');
  assert.throws(() => surface.setPanel('everything'), /panel must be one of/);
});

test('E requests are declared and explicit, and settings data never changes', () => {
  const surface = readySurface();
  assert.equal(surface.requestSave(ENTRY_A.id), 'requested');
  assert.equal(surface.requestReset(ENTRY_P.id), 'requested');
  assert.equal(surface.requestSave('ghost'), 'unknown-id');
  assert.equal(surface.requestReset('ghost'), 'unknown-id');
  surface.setLoading();
  assert.equal(surface.requestSave(ENTRY_A.id), 'not-ready');
  assert.equal(surface.requestReset(ENTRY_A.id), 'not-ready');
  assert.throws(() => surface.requestSave(''), /non-empty/);
  assert.throws(() => surface.requestReset(''), /non-empty/);
  // The declared request changed no settings data.
  surface.setPanel('instance');
  assert.equal(surface.displayModel().total, 3);
});

test('E failure is explicit: the error region carries a retry affordance', () => {
  const surface = createSettingsSurface();
  assert.equal(surface.loadFailure({ kind: 'network' }), 'error');
  const model = surface.displayModel();
  assert.deepEqual([...model.actions], ['refresh']);
  assert.throws(() => surface.loadFailure(null), /error object/);
  const degraded = createSettingsSurface({ renderAvailable: false });
  degraded.loadSuccess([ENTRY_A]);
  assert.ok(degraded.degradedEvents > 0);
});

test('E loadSuccess resets the panel and history is deterministic', () => {
  const surface = readySurface();
  surface.setPanel('personal');
  surface.loadSuccess([ENTRY_A, ENTRY_B, ENTRY_P]);
  assert.equal(surface.displayModel().panel, SETTINGS_DEFAULT_PANEL);
  const again = createSettingsSurface();
  // Both panels have entries so the switch lands in ready and the declared
  // save is actually issued (a save on an empty panel would be not-ready).
  again.loadSuccess([ENTRY_A, ENTRY_P]);
  again.setPanel('personal');
  again.requestSave(ENTRY_P.id);
  assert.deepEqual(again.history.map((h) => h.name), ['loaded', 'switched-panel', 'save-requested']);
});
